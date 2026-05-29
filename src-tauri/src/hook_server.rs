//! Loopback HTTP server that receives Agent hook events.
//!
//! Each Agent (Claude Code, Copilot, etc.) is provisioned with a hook that runs
//! the `abundio-hook` relay script; the relay POSTs the hook payload here. This
//! server validates a per-launch token, then re-emits the event as a Tauri
//! event `agent-hook-{ptyId}` so the frontend can drive the status indicator.
//!
//! Bound to `127.0.0.1` only. The relay correlates events to a PTY via the
//! `ABUNDIO_PTY_ID` env var injected at PTY spawn.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::events::AgentHookEvent;

/// Managed Tauri state. Holds the live port + token so `pty_manager` can inject
/// them into every spawned PTY's environment.
pub struct HookServer {
    pub port: u16,
    pub token: String,
}

impl HookServer {
    /// Bind the server to an ephemeral loopback port and start the accept loop
    /// on a dedicated thread. Returns immediately.
    ///
    /// The accept loop is wrapped in a restart-on-death wrapper: if
    /// `tiny_http`'s internal accept thread terminates (e.g. after macOS sleep
    /// invalidates the listener's accept syscall), we rebind to the **same**
    /// port and resume. The port must stay stable because it's captured in
    /// every running PTY's `ABUNDIO_HOOK_PORT` env var at spawn time.
    pub fn start(app: AppHandle) -> Result<HookServer, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|addr| addr.port())
            .ok_or_else(|| "hook server bound to a non-IP address".to_string())?;
        let token = uuid::Uuid::new_v4().to_string();

        let token_for_thread = token.clone();
        thread::spawn(move || run_accept_loop(app, token_for_thread, server, port));

        Ok(HookServer { port, token })
    }
}

/// Outer supervisor for the hook server's accept loop. Each pass drains
/// requests from a live `tiny_http::Server`; if its `incoming_requests`
/// iterator terminates (the internal accept thread died), we log loudly and
/// rebind on the same port before continuing. Runs for the lifetime of the
/// process — Tauri shuts the thread down when the app exits.
fn run_accept_loop(
    app: AppHandle,
    token: String,
    initial_server: tiny_http::Server,
    port: u16,
) {
    let mut server = initial_server;
    loop {
        for request in server.incoming_requests() {
            // A panic inside handle_request (e.g. a slicing bug on a weird
            // payload) would otherwise unwind out of the thread, defeating
            // the rebind logic below. Catching here keeps the supervisor
            // alive across malformed requests.
            if let Err(_) = catch_unwind(AssertUnwindSafe(|| handle_request(&app, &token, request)))
            {
                eprintln!(
                    "[{}] [abundio:hook] handler panicked; continuing accept loop",
                    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z")
                );
            }
        }

        eprintln!(
            "[{}] [abundio:hook] accept loop exited unexpectedly; rebinding 127.0.0.1:{}",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
            port
        );

        server = loop {
            match tiny_http::Server::http(format!("127.0.0.1:{}", port)) {
                Ok(s) => {
                    eprintln!(
                        "[{}] [abundio:hook] rebound 127.0.0.1:{}",
                        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
                        port
                    );
                    break s;
                }
                Err(e) => {
                    eprintln!(
                        "[{}] [abundio:hook] rebind 127.0.0.1:{} failed: {}; retrying in 1s",
                        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
                        port,
                        e
                    );
                    thread::sleep(Duration::from_secs(1));
                }
            }
        };
    }
}

/// Parse one query-string value (no percent-decoding needed — the relay only
/// ever sends identifier-like values: event names, agent ids, UUIDs).
fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let mut kv = pair.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some(k), Some(v)) if k == key => Some(v),
            _ => None,
        }
    })
}

/// Constant-time equality for the token comparison. A naive `==` short-circuits
/// on the first mismatching byte, leaking the prefix byte-by-byte to a local
/// attacker who can hammer the loopback port. The listener is already locked
/// down (loopback + UUID token + custom header), but defense-in-depth: a
/// timing leak here would hand a same-user process the token after a few
/// hundred thousand requests, which is enough to drive arbitrary
/// `agent-hook-*` events into the renderer.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Read a header value off a tiny_http request without consuming the request.
/// `name` is `&'static str` because `tiny_http::HeaderField::equiv` requires it.
fn header_value<'a>(request: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

/// Max payload size we'll inline in the debug log. Larger payloads get truncated
/// with a marker — we still log the head so toolName/args are visible.
const MAX_LOGGED_PAYLOAD: usize = 8 * 1024;

/// Truncate a `&str` to at most `max_bytes` without splitting a UTF-8 code
/// point. Plain `&s[..max_bytes]` panics when `max_bytes` lands inside a
/// multi-byte char (e.g. `—` is 3 bytes); agent payloads regularly contain
/// such chars right at the 8 KiB boundary.
fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn handle_request(app: &AppHandle, token: &str, mut request: tiny_http::Request) {
    let token_bytes = token.as_bytes();
    let authorized = request.headers().iter().any(|h| {
        h.field.equiv("X-Abundio-Token")
            && constant_time_eq(h.value.as_str().as_bytes(), token_bytes)
    });
    if !authorized {
        eprintln!(
            "[{}] [abundio:hook] 403 — rejected request with bad/missing token",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z")
        );
        let _ = request.respond(tiny_http::Response::empty(403));
        return;
    }

    let url = request.url().to_string();
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
    let event = query_value(query, "event").unwrap_or("").to_string();
    let agent = query_value(query, "agent").unwrap_or("").to_string();
    let pty = query_value(query, "pty").unwrap_or("").to_string();

    let workspace = header_value(&request, "X-Abundio-Workspace")
        .unwrap_or("?")
        .to_string();
    let window = header_value(&request, "X-Abundio-Window-Label")
        .unwrap_or("?")
        .to_string();

    let mut payload = String::new();
    let _ = request.as_reader().read_to_string(&mut payload);

    // Always answer the relay so it can exit cleanly.
    let _ = request.respond(tiny_http::Response::from_string("{}"));

    // `toolName` (when the payload carries it) disambiguates tool-scoped events
    // like Copilot's preToolUse — the frontend uses it to special-case tools
    // that block on the user (exit_plan_mode, multiple-choice questions).
    let tool = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|v| v.get("toolName")?.as_str().map(str::to_owned))
        .unwrap_or_default();

    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
    let payload_for_log = if payload.len() > MAX_LOGGED_PAYLOAD {
        format!(
            "{}… <truncated, {} bytes total>",
            truncate_at_char_boundary(&payload, MAX_LOGGED_PAYLOAD),
            payload.len()
        )
    } else if payload.is_empty() {
        "<empty>".to_string()
    } else {
        payload.clone()
    };
    eprintln!(
        "[{ts}] [abundio:hook] workspace={workspace:?} window={window} agent={agent} event={event} tool={tool} pty={pty}\n  payload: {payload_for_log}"
    );

    if pty.is_empty() || event.is_empty() {
        eprintln!("[{ts}] [abundio:hook] dropped — empty pty or event");
        return;
    }
    let _ = app.emit(
        &format!("agent-hook-{}", pty),
        AgentHookEvent {
            agent,
            event,
            payload,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_value_extracts_keys() {
        let q = "event=Stop&agent=claude&pty=abc-123";
        assert_eq!(query_value(q, "event"), Some("Stop"));
        assert_eq!(query_value(q, "agent"), Some("claude"));
        assert_eq!(query_value(q, "pty"), Some("abc-123"));
        assert_eq!(query_value(q, "missing"), None);
    }

    #[test]
    fn query_value_handles_empty() {
        assert_eq!(query_value("", "event"), None);
    }

    #[test]
    fn truncate_at_char_boundary_preserves_utf8() {
        // Em-dash `—` is 3 bytes (E2 80 94). Slicing inside it must not panic.
        let mut s = "a".repeat(8191);
        s.push('—'); // bytes 8191..8194
        s.push_str("trailing");
        let truncated = truncate_at_char_boundary(&s, 8192);
        // 8192 lands inside the em-dash → step back to byte 8191.
        assert_eq!(truncated.len(), 8191);
        // Result is a valid &str.
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn truncate_at_char_boundary_passthrough_when_short() {
        assert_eq!(truncate_at_char_boundary("hello", 8192), "hello");
        assert_eq!(truncate_at_char_boundary("", 8192), "");
    }

    #[test]
    fn truncate_at_char_boundary_on_ascii_is_exact() {
        let s = "x".repeat(10_000);
        assert_eq!(truncate_at_char_boundary(&s, 8192).len(), 8192);
    }

    #[test]
    fn constant_time_eq_matches_only_on_full_byte_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }
}

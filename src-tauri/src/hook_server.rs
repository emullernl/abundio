//! Loopback HTTP server that receives Agent hook events.
//!
//! Each Agent (Claude Code, Copilot, etc.) is provisioned with a hook that runs
//! the `abundio-hook` relay script; the relay POSTs the hook payload here. This
//! server validates a per-launch token, then re-emits the event as a Tauri
//! event `agent-hook-{ptyId}` so the frontend can drive the status indicator.
//!
//! Bound to `127.0.0.1` only. The relay correlates events to a PTY via the
//! `ABUNDIO_PTY_ID` env var injected at PTY spawn.

use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

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
    let path = url.splitn(2, '?').next().unwrap_or("");

    // The `abundio-env` helper rides the same authenticated loopback server as
    // the agent hook relay — same token, same origin restriction. Handled before
    // the hook parsing below because these routes have their own body shape.
    if path == "/env/print" || path == "/env/list" || path == "/env/raw" {
        handle_env_request(app, path, request);
        return;
    }

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

/// Serve `abundio-env list` / `abundio-env print <bundle>` for one pane.
///
/// The Workspace is resolved from `ptyId` through the PtyManager's spawn-context
/// map rather than taken from the request body, so a caller can name a bundle
/// but not a workspace. That stops a typo or a naive caller reaching another
/// Workspace.
///
/// It is NOT a security boundary between panes, and should not be described as
/// one. The `X-Abundio-Token` header is the process-wide hook token — identical
/// in every pane — and `ABUNDIO_PTY_ID` sits in every pane's environment, which
/// any same-user process can read (`/proc/<pid>/environ`, `ps eww`). The real
/// property is "a process running as you can read any Workspace's on-demand
/// bundles", which is inside the threat model in ADR-0024. What the token does
/// buy is that a process *outside* an Abundio terminal cannot read anything.
fn handle_env_request(app: &AppHandle, path: &str, mut request: tiny_http::Request) {
    // Bounded: an authenticated caller should not be able to make the server
    // buffer an arbitrary amount. These bodies are two short JSON fields.
    const MAX_ENV_REQUEST_BODY: u64 = 64 * 1024;
    let mut body = String::new();
    // `as_reader()` hands back a trait object, so `Read::take` needs an
    // explicit `by_ref` to have a sized receiver.
    let reader = request.as_reader();
    if (&mut *reader)
        .take(MAX_ENV_REQUEST_BODY)
        .read_to_string(&mut body)
        .is_err()
    {
        let _ = request.respond(tiny_http::Response::empty(400));
        return;
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let pty_id = parsed.get("ptyId").and_then(|v| v.as_str()).unwrap_or("");
    let bundle = parsed.get("bundle").and_then(|v| v.as_str()).unwrap_or("");

    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");

    let Some(ctx) = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr: tauri::State<crate::pty_manager::PtyManager>| {
            mgr.spawn_context(pty_id)
        })
    else {
        eprintln!("[{ts}] [abundio:env] 404 — unknown pty {pty_id:?}");
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    };

    let Some(store) = app.try_state::<crate::env_vars::EnvVarStore>() else {
        let _ = request.respond(tiny_http::Response::empty(503));
        return;
    };

    if path == "/env/list" {
        let names = store
            .bundle_names(&ctx.workspace_id, ctx.inherit_from.as_deref())
            .unwrap_or_default();
        eprintln!("[{ts}] [abundio:env] list — {} bundle(s)", names.len());
        let _ = request.respond(tiny_http::Response::from_string(names.join("\n")));
        return;
    }

    let key = match crate::env_crypto::master_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[{ts}] [abundio:env] 503 — credential store unavailable: {e}");
            let _ = request.respond(tiny_http::Response::empty(503));
            return;
        }
    };

    match store.resolve_bundle(&key, &ctx.workspace_id, ctx.inherit_from.as_deref(), bundle) {
        Ok(pairs) => {
            // Log the bundle name and count only. Never the values — this log
            // goes to stderr and is exactly the sort of thing that ends up in a
            // support paste.
            eprintln!(
                "[{ts}] [abundio:env] {} bundle={bundle:?} — {} variable(s)",
                if path == "/env/raw" { "raw" } else { "print" },
                pairs.len()
            );
            let body = if path == "/env/raw" {
                // NUL-delimited `KEY=VALUE` records for `abundio-env run`. NUL is
                // the one byte that cannot occur in an environment variable, so
                // the reader needs no escaping rules and no `eval` — which
                // matters because these values are arbitrary user data.
                pairs
                    .iter()
                    .map(|(name, value)| format!("{name}={}\0", value.as_str()))
                    .collect::<String>()
            } else {
                pairs
                    .iter()
                    .map(|(name, value)| format!("{name}={}", quote_dotenv_value(value)))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let _ = request.respond(tiny_http::Response::from_string(body));
        }
        Err(e) => {
            eprintln!("[{ts}] [abundio:env] 404 — bundle {bundle:?}: {e}");
            let _ = request.respond(tiny_http::Response::empty(404));
        }
    }
}

/// Quote a value for `.env` output.
///
/// The consumer is a `--env-file` parser, not a shell, so this is dotenv
/// escaping rather than shell escaping. Must round-trip through
/// `parseDotenv` in `src/lib/dotenvParse.ts` — a certificate's newlines have to
/// survive both directions.
fn quote_dotenv_value(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The output of `abundio-env print` is consumed by a `--env-file` parser
    /// and by `parseDotenv` in the import dialog. These assertions are the
    /// contract between the two — in particular that a certificate's newlines
    /// survive, since that is the whole point of storing one.
    #[test]
    fn quote_dotenv_value_escapes_for_a_dotenv_reader() {
        assert_eq!(quote_dotenv_value("simple"), "\"simple\"");
        assert_eq!(quote_dotenv_value(""), "\"\"");
        assert_eq!(quote_dotenv_value("has space"), "\"has space\"");
        assert_eq!(quote_dotenv_value("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_dotenv_value("a\\b"), "\"a\\\\b\"");
        assert_eq!(quote_dotenv_value("line1\nline2"), "\"line1\\nline2\"");
        assert_eq!(quote_dotenv_value("a\tb"), "\"a\\tb\"");
    }

    /// A backslash must be escaped BEFORE the newline, or `\` + `n` in the
    /// source would come back as a real newline.
    #[test]
    fn quote_dotenv_value_does_not_double_unescape() {
        // Literal backslash-n in the value, not a newline.
        assert_eq!(quote_dotenv_value("a\\nb"), "\"a\\\\nb\"");
    }

    #[test]
    fn quote_dotenv_value_handles_a_certificate() {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIDdz\n-----END CERTIFICATE-----\n";
        let quoted = quote_dotenv_value(pem);
        assert!(quoted.starts_with('"') && quoted.ends_with('"'));
        assert!(!quoted[1..quoted.len() - 1].contains('\n'), "raw newlines would break KEY=value lines");
        assert!(quoted.contains("\\n"));
    }

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

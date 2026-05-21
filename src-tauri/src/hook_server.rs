//! Loopback HTTP server that receives Agent hook events.
//!
//! Each Agent (Claude Code, Copilot, etc.) is provisioned with a hook that runs
//! the `abundio-hook` relay script; the relay POSTs the hook payload here. This
//! server validates a per-launch token, then re-emits the event as a Tauri
//! event `agent-hook-{ptyId}` so the frontend can drive the status indicator.
//!
//! Bound to `127.0.0.1` only. The relay correlates events to a PTY via the
//! `ABUNDIO_PTY_ID` env var injected at PTY spawn.

use std::thread;

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
    pub fn start(app: AppHandle) -> Result<HookServer, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|addr| addr.port())
            .ok_or_else(|| "hook server bound to a non-IP address".to_string())?;
        let token = uuid::Uuid::new_v4().to_string();

        let token_for_thread = token.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                handle_request(&app, &token_for_thread, request);
            }
        });

        Ok(HookServer { port, token })
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

fn handle_request(app: &AppHandle, token: &str, mut request: tiny_http::Request) {
    // Token check — reject anything that doesn't present the per-launch secret.
    let authorized = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Abundio-Token") && h.value.as_str() == token);
    if !authorized {
        eprintln!("[abundio:hook] 403 — rejected request with bad/missing token");
        let _ = request.respond(tiny_http::Response::empty(403));
        return;
    }

    let url = request.url().to_string();
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
    let event = query_value(query, "event").unwrap_or("").to_string();
    let agent = query_value(query, "agent").unwrap_or("").to_string();
    let pty = query_value(query, "pty").unwrap_or("").to_string();

    let mut payload = String::new();
    let _ = request.as_reader().read_to_string(&mut payload);

    // Always answer the relay so it can exit cleanly.
    let _ = request.respond(tiny_http::Response::from_string("{}"));

    eprintln!("[abundio:hook] received agent={agent} event={event} pty={pty}");

    if pty.is_empty() || event.is_empty() {
        eprintln!("[abundio:hook] dropped — empty pty or event");
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
}

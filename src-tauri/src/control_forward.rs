//! Agent control from this computer to a Joined profile's Host (ADR-0065,
//! docs/plans/remote-hosts.md phase 12b). A call naming `Agent Two@build-box`
//! or `--workspace app@build-box` is carried over the app's own connection
//! to that Host, as `control_call`, for the caller's Window; the Host answers
//! it as it answers its own panes, and its answer is the caller's. Never the
//! other way: the server sets no forwarder.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use abundio_core::control_host::{error_answer, Answer, Caller, ControlForward};
use abundio_core::host_api::Host;
use abundio_core::host_router::{CallError, HostRouter};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub struct Forwarder {
    app: AppHandle,
    /// Calls carried and still waiting, by request id: their Host and
    /// Window, so an interrupted caller's cancel reaches them.
    inflight: Mutex<HashMap<String, (String, String)>>,
}

impl Forwarder {
    pub fn new(app: AppHandle) -> Self {
        Forwarder { app, inflight: Mutex::new(HashMap::new()) }
    }

    fn router(&self) -> Arc<HostRouter> {
        self.app.state::<Arc<HostRouter>>().inner().clone()
    }
}

/// This computer's name, as a Host shows a caller from here
/// (`Agent One@<name>`): the OS's own name for it, read once.
pub fn computer_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let run = |cmd: &str, args: &[&str]| {
            std::process::Command::new(cmd)
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let name = if cfg!(target_os = "macos") {
            run("scutil", &["--get", "ComputerName"])
        } else {
            None
        };
        name.or_else(|| run("hostname", &[]))
            .unwrap_or_else(|| "this computer".to_string())
    })
    .clone()
}

/// The caller as this computer names it: its handle, else "an Agent".
fn caller_handle(host: &Host<'_>, caller: &Caller) -> String {
    let tabs = host
        .workspaces
        .list_tabs(&caller.workspace_id)
        .unwrap_or_default();
    for t in tabs {
        let Ok(layout) = serde_json::from_str::<Value>(&t.layout_json) else { continue };
        if let Some(h) = find_handle(&layout, &caller.pane_id) {
            return h;
        }
    }
    "an Agent".to_string()
}

fn find_handle(node: &Value, pane_id: &str) -> Option<String> {
    if node.get("id").and_then(Value::as_str) == Some(pane_id) {
        return node.get("agentHandle").and_then(Value::as_str).filter(|h| !h.is_empty()).map(str::to_string);
    }
    ["first", "second"].iter().find_map(|k| node.get(*k).and_then(|n| find_handle(n, pane_id)))
}

impl ControlForward for Forwarder {
    fn forward(
        &self,
        host: &Host<'_>,
        caller: &Caller,
        host_name: &str,
        argv: Vec<String>,
        request_id: Option<String>,
    ) -> Option<Answer> {
        // Only the Hosts of the caller's own Profile's Joined profiles.
        let profile = host.workspaces.profile_of(&caller.workspace_id).ok().flatten()?;
        let joined = {
            let conn = host.workspaces.conn.lock().ok()?;
            abundio_core::joined_profiles::list(&conn, &profile).ok()?
        };
        let host_id = joined.iter().find_map(|j| {
            crate::hosts::find(&j.host_id)
                .filter(|h| h.name.eq_ignore_ascii_case(host_name))
                .map(|h| h.id)
        })?;
        let router = self.router();
        if !router.is_connected(&host_id) {
            return Some(error_answer(
                503,
                "host_offline",
                &format!("{host_name} is not connected; its Agents are out of reach until it is"),
            ));
        }
        let window = caller.window_label.clone();
        let label = format!("{}@{}", caller_handle(host, caller), computer_name());
        if let Some(id) = &request_id {
            self.inflight.lock().unwrap().insert(id.clone(), (host_id.clone(), window.clone()));
        }
        let result = router.call_on(
            &host_id,
            &window,
            "control_call",
            json!({ "argv": argv, "label": label, "owner": caller.pane_id, "requestId": request_id }),
        );
        if let Some(id) = &request_id {
            self.inflight.lock().unwrap().remove(id);
        }
        Some(match result {
            Ok(v) => Answer {
                status: v.get("status").and_then(Value::as_u64).unwrap_or(500) as u16,
                body: v.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
            },
            Err(CallError::NotConnected(_)) => error_answer(
                503,
                "host_offline",
                &format!("{host_name} is not connected; its Agents are out of reach until it is"),
            ),
            Err(CallError::ConnectionLost) => error_answer(
                503,
                "connection_lost",
                &format!("the connection to {host_name} dropped during this call, so it may already have happened; check before running it again"),
            ),
            Err(CallError::Failed(e)) => error_answer(
                500,
                "internal",
                &format!("{host_name} could not run it: {}", e.get("message").and_then(Value::as_str).unwrap_or("an error")),
            ),
        })
    }

    fn cancel(&self, caller: &Caller, request_id: &str) -> bool {
        let Some((host_id, window)) = self.inflight.lock().unwrap().get(request_id).cloned() else {
            return false;
        };
        self.router()
            .call_on(&host_id, &window, "control_cancel", json!({ "owner": caller.pane_id, "requestId": request_id }))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_callers_handle_in_its_layout() {
        let layout = json!({ "type": "split", "id": "s", "first": { "type": "terminal", "id": "a", "agentHandle": "Lead" },
            "second": { "type": "terminal", "id": "b" } });
        assert_eq!(find_handle(&layout, "a").as_deref(), Some("Lead"));
        assert_eq!(find_handle(&layout, "b"), None);
        assert!(!computer_name().is_empty());
    }
}

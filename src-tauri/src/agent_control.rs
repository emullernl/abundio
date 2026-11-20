//! **Agent control** (ADR-0054) in the desktop app: the hook server's view
//! of the app. Checking, routing and answering a call is the core's
//! (`control_host.rs`), on the same `Host` the host commands use, so an
//! Abundio server does it the same way.

use tauri::{AppHandle, Manager};

pub use crate::control_host::*;

/// The hook server's view of the desktop app (`hook_server::HookHost`).
pub struct AppHookHost(pub AppHandle);

impl crate::hook_server::HookHost for AppHookHost {
    /// Applied here, where the PTY runs (phase 6d): the owning Window gets
    /// what it keeps besides the status (`agent-hook-applied`), then the
    /// status (`status-updates`), in that order, as it did them.
    fn hook_event(&self, pty_id: &str, event: crate::events::AgentHookEvent) {
        use crate::event_sink::EventsExt;
        let status = self.0.state::<std::sync::Arc<crate::status_store::StatusStore>>();
        let applied = crate::hook_apply::apply(
            &status,
            pty_id,
            &event.agent,
            &event.event,
            &event.payload,
            crate::hook_apply::now_ms(),
            &crate::status_machine::StatusConfig::default(),
        );
        let client = status.owner(pty_id).or_else(|| {
            self.0
                .state::<crate::pty_manager::PtyManager>()
                .owner_window(pty_id)
                .map(crate::event_sink::ClientId)
        });
        let Some(client) = client else { return };
        let events = self.0.state::<crate::event_sink::Events>();
        events.to_client(&client, "agent-hook-applied", &applied.notice);
        if !applied.updates.is_empty() {
            events.to_client(&client, "status-updates", applied.updates);
        }
    }
    fn ptys(&self) -> Option<&crate::pty_manager::PtyManager> {
        self.0.try_state::<crate::pty_manager::PtyManager>().map(|s| s.inner())
    }
    fn env_store(&self) -> Option<&crate::env_vars::EnvVarStore> {
        self.0.try_state::<crate::env_vars::EnvVarStore>().map(|s| s.inner())
    }
    fn control_refuse_unknown(&self, request: tiny_http::Request) -> Option<tiny_http::Request> {
        crate::host_commands::with_host(&self.0, |host| crate::control_host::refuse_unknown(host, request))
    }
    fn control_serve(&self, request: tiny_http::Request) {
        crate::host_commands::with_host(&self.0, |host| crate::control_host::serve(host, request))
    }
}


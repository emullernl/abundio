//! The desktop app's [`EventSink`]: Tauri events, and PTY output raw on each
//! Window's channel (`pty_output_subscribe`). The headless server has its own
//! sink (docs/plans/remote-hosts.md phase 7).

use std::sync::Arc;

use serde_json::Value;

use crate::event_sink::{frame_pty_output, ClientId, EventSink, Events};

/// Each Window's PTY output channel (`pty_output_subscribe`). PTY bytes go
/// to every Window raw, framed by [`frame_pty_output`], instead of as base64
/// events: no encoding, and one ordered stream per Window.
#[derive(Default)]
pub struct PtyChannels {
    by_client: dashmap::DashMap<String, tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>>,
}

impl PtyChannels {
    pub fn set(&self, client: &str, channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) {
        self.by_client.insert(client.to_string(), channel);
    }

    /// A destroyed Window's channel would fail every send until removed.
    pub fn forget(&self, client: &str) {
        self.by_client.remove(client);
    }

    /// Send one Window its PTY bytes (a remote Host's output, phase 7c).
    pub fn send_to(&self, client: &str, frame: &[u8]) {
        let body = tauri::ipc::InvokeResponseBody::Raw(frame.to_vec());
        let failed = self.by_client.get(client).is_some_and(|c| c.send(body).is_err());
        if failed {
            self.by_client.remove(client);
        }
    }

    pub(crate) fn send_all(&self, frame: &[u8]) {
        let mut dead = Vec::new();
        for entry in self.by_client.iter() {
            let body = tauri::ipc::InvokeResponseBody::Raw(frame.to_vec());
            if entry.value().send(body).is_err() {
                dead.push(entry.key().clone());
            }
        }
        for client in dead {
            self.by_client.remove(&client);
        }
    }
}

/// The desktop app's sink: Tauri events, and PTY output on each Window's
/// channel.
pub struct TauriSink {
    app: tauri::AppHandle,
    pty_channels: Arc<PtyChannels>,
}

impl EventSink for TauriSink {
    fn broadcast_value(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn to_client_value(&self, client: &ClientId, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit_to(client.as_str(), event, payload);
    }

    fn pty_output(&self, pty_id: &str, data: &[u8]) {
        self.pty_channels.send_all(&frame_pty_output(pty_id, data));
    }
}

impl TauriSink {
    pub fn shared(app: &tauri::AppHandle, pty_channels: Arc<PtyChannels>) -> Events {
        Arc::new(TauriSink {
            app: app.clone(),
            pty_channels,
        })
    }
}

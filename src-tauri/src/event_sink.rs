//! Where backend events go (docs/plans/remote-hosts.md phase 1).
//!
//! Core modules (PTYs, search, git, file watching, hooks…) never hold a Tauri
//! `AppHandle` to emit: they hold an [`EventSink`]. In the desktop app the sink
//! is [`TauriSink`], which turns each call into a Tauri event. An Abundio
//! server (ADR-0062) will supply its own sink that sends events to its
//! Clients, and tests use [`RecordingSink`].
//!
//! A [`ClientId`] names one Client: today always a Window label.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

/// One Client of the backend. Locally a Window, named by its label.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClientId(pub String);

impl ClientId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for ClientId {
    fn from(s: &str) -> Self {
        ClientId(s.to_string())
    }
}

/// Object-safe event delivery. Use the [`Events`] helpers to send typed
/// payloads.
pub trait EventSink: Send + Sync + 'static {
    /// Deliver to every Client.
    fn broadcast_value(&self, event: &str, payload: Value);
    /// Deliver to one Client only.
    fn to_client_value(&self, client: &ClientId, event: &str, payload: Value);
    /// A PTY's output bytes, in order. The default sends the base64
    /// `pty-output-{id}` event every Client hears.
    fn pty_output(&self, pty_id: &str, data: &[u8]) {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.broadcast_value(
            &format!("pty-output-{pty_id}"),
            serde_json::json!({ "data": encoded }),
        );
    }
}

/// A shared sink, cheap to clone into threads.
pub type Events = Arc<dyn EventSink>;

/// Typed helpers over any sink.
pub trait EventsExt {
    fn broadcast<T: Serialize>(&self, event: &str, payload: T);
    fn to_client<T: Serialize>(&self, client: &ClientId, event: &str, payload: T);
}

impl<S: EventSink + ?Sized> EventsExt for S {
    fn broadcast<T: Serialize>(&self, event: &str, payload: T) {
        match serde_json::to_value(payload) {
            Ok(v) => self.broadcast_value(event, v),
            Err(e) => log::warn!("[events] could not serialize {event}: {e}"),
        }
    }

    fn to_client<T: Serialize>(&self, client: &ClientId, event: &str, payload: T) {
        match serde_json::to_value(payload) {
            Ok(v) => self.to_client_value(client, event, v),
            Err(e) => log::warn!("[events] could not serialize {event}: {e}"),
        }
    }
}

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

    fn send_all(&self, frame: &[u8]) {
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

/// One PTY output message on a Window's channel: a byte with the pty id's
/// length, the id (ASCII), then the output bytes. `ipc.ts` reads it back.
pub fn frame_pty_output(pty_id: &str, data: &[u8]) -> Vec<u8> {
    let id = pty_id.as_bytes();
    debug_assert!(id.len() <= u8::MAX as usize);
    let len = id.len().min(u8::MAX as usize);
    let mut frame = Vec::with_capacity(1 + len + data.len());
    frame.push(len as u8);
    frame.extend_from_slice(&id[..len]);
    frame.extend_from_slice(data);
    frame
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

/// A sink that remembers everything sent, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    pub sent: std::sync::Mutex<Vec<(Option<ClientId>, String, Value)>>,
}

#[cfg(test)]
impl EventSink for RecordingSink {
    fn broadcast_value(&self, event: &str, payload: Value) {
        self.sent
            .lock()
            .unwrap()
            .push((None, event.to_string(), payload));
    }

    fn to_client_value(&self, client: &ClientId, event: &str, payload: Value) {
        self.sent
            .lock()
            .unwrap()
            .push((Some(client.clone()), event.to_string(), payload));
    }
}

#[cfg(test)]
impl RecordingSink {
    pub fn events(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e, _)| e.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_helpers_serialize_payloads() {
        let sink = RecordingSink::default();
        sink.broadcast("x", crate::events::PtyStatus::Exited { code: Some(3) });
        sink.to_client(&ClientId::from("window-1"), "y", 5);
        let sent = sink.sent.lock().unwrap();
        assert_eq!(sent[0].0, None);
        assert_eq!(sent[0].2, serde_json::json!({ "type": "exited", "code": 3 }));
        assert_eq!(sent[1].0, Some(ClientId::from("window-1")));
        assert_eq!(sent[1].1, "y");
    }

    #[test]
    fn default_pty_output_is_the_base64_event() {
        let sink = RecordingSink::default();
        sink.pty_output("p1", b"hi");
        let sent = sink.sent.lock().unwrap();
        assert_eq!(sent[0].1, "pty-output-p1");
        assert_eq!(sent[0].2, serde_json::json!({ "data": "aGk=" }));
    }

    #[test]
    fn frames_pty_output_with_its_id() {
        let frame = frame_pty_output("abc", &[1, 2]);
        assert_eq!(frame, vec![3, b'a', b'b', b'c', 1, 2]);
        assert_eq!(frame_pty_output("", b""), vec![0]);
    }

    #[test]
    fn works_through_a_shared_handle() {
        let rec = Arc::new(RecordingSink::default());
        let events: Events = rec.clone();
        events.broadcast("z", true);
        assert_eq!(rec.events(), vec!["z".to_string()]);
    }
}

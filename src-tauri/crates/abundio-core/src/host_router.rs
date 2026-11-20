//! The desktop's routing to remote Hosts (docs/plans/remote-hosts.md phase
//! 7c): one connection per Host, shared by every Window on it; each Window
//! bound to at most one Host (its Active profile's), with this computer as
//! the default.
//!
//! A host command from a bound Window goes to its Host as a request under
//! the Window's own Client id; the Host's events come back to that Window
//! under the same names the local backend uses, and an event for every
//! Client of the connection to every Window bound to that Host (never to a
//! Window on another Host or on this computer). PTY output comes once per
//! connection and goes into each bound Window's output channel, framed as
//! local output is. The Window itself never touches the connection.

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::host_client::{HostClient, HostListener, HostProcess, RequestError};

/// Where a Window's events and PTY bytes go: the desktop app's Windows.
pub trait WindowSink: Send + Sync + 'static {
    /// An event, under the name the local backend would have used.
    fn emit_to(&self, window: &str, event: &str, payload: Value);
    /// PTY output, already framed (`event_sink::frame_pty_output`).
    fn pty_frame(&self, window: &str, frame: &[u8]);
}

/// How to reach a Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostTarget {
    /// The user's own `ssh`: a `~/.ssh/config` alias or `user@host`.
    Ssh {
        destination: String,
        /// The server program on the Host (phase 8 installs it in a fixed
        /// place; until then whatever the user put on the Host's PATH).
        #[serde(default)]
        server: Option<String>,
    },
    /// An `abundio-server` on this computer, reached without SSH (tests and
    /// development).
    Direct { server: String, data_dir: Option<String> },
}

impl HostTarget {
    /// The program that carries the connection.
    pub fn command(&self) -> Command {
        match self {
            HostTarget::Ssh { destination, server } => {
                let mut c = Command::new("ssh");
                // No terminal, keepalives so a dead link is noticed, and the
                // user's own config for everything else.
                c.args(["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--"])
                    .arg(destination)
                    .arg(server.as_deref().unwrap_or("abundio-server"))
                    .arg("connect");
                c
            }
            HostTarget::Direct { server, data_dir } => {
                let mut c = Command::new(server);
                c.arg("connect");
                if let Some(d) = data_dir {
                    c.args(["--data-dir", d]);
                }
                c
            }
        }
    }
}

/// Why a call to a Host failed, as the Window sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The command ran there and failed: its own error.
    Failed(Value),
    /// The Window is bound to a Host that is not connected.
    NotConnected(String),
    /// The connection ended before the answer; the command may have run.
    ConnectionLost,
}

struct Connection {
    client: Arc<HostClient>,
    _process: HostProcess,
}

#[derive(Default)]
struct State {
    connections: HashMap<String, Connection>,
    /// Window → the Host it is bound to.
    windows: HashMap<String, String>,
}

/// Every Host connection of this desktop app, and which Window is on which.
pub struct HostRouter {
    state: Mutex<State>,
    sink: Arc<dyn WindowSink>,
    me: Weak<HostRouter>,
}

/// Told when a connection ends, so its Windows can show it.
pub const CONNECTION_LOST_EVENT: &str = "host-connection-lost";

/// Told when a connection opens, so a Window that loaded before it can load
/// again.
pub const CONNECTED_EVENT: &str = "host-connected";

struct Listener {
    host: String,
    router: Weak<HostRouter>,
}

impl HostListener for Listener {
    fn event(&self, client: Option<&str>, name: &str, payload: Value) {
        let Some(router) = self.router.upgrade() else { return };
        match client {
            Some(window) => {
                if router.host_of(window).as_deref() == Some(self.host.as_str()) {
                    router.sink.emit_to(window, name, payload);
                }
            }
            None => {
                for window in router.windows_on(&self.host) {
                    router.sink.emit_to(&window, name, payload.clone());
                }
            }
        }
    }

    fn pty(&self, _client: &str, pty_id: &str, bytes: &[u8]) {
        let Some(router) = self.router.upgrade() else { return };
        let frame = crate::event_sink::frame_pty_output(pty_id, bytes);
        for window in router.windows_on(&self.host) {
            router.sink.pty_frame(&window, &frame);
        }
    }

    fn closed(&self, why: &str) {
        let Some(router) = self.router.upgrade() else { return };
        log::warn!("[host] the connection to {} ended: {why}", self.host);
        let windows = router.windows_on(&self.host);
        router.state.lock().unwrap().connections.remove(&self.host);
        for window in windows {
            router.sink.emit_to(
                &window,
                CONNECTION_LOST_EVENT,
                serde_json::json!({ "host": self.host, "reason": why }),
            );
        }
    }
}

impl HostRouter {
    pub fn new(sink: Arc<dyn WindowSink>) -> Arc<Self> {
        Arc::new_cyclic(|me| HostRouter { state: Mutex::default(), sink, me: me.clone() })
    }

    /// Connect to `host` (named by the caller, e.g. its ssh destination)
    /// unless already connected. Blocks for the handshake: on a password or
    /// 2FA prompt, until it is answered.
    pub fn connect(&self, host: &str, target: &HostTarget) -> Result<String, String> {
        if let Some(c) = self.state.lock().unwrap().connections.get(host) {
            if !c.client.is_closed() {
                return Ok(c.client.server_version.clone());
            }
        }
        let listener = Arc::new(Listener { host: host.to_string(), router: self.me.clone() });
        let (client, process) = HostProcess::spawn(target.command(), listener)?;
        let version = client.server_version.clone();
        self.state
            .lock()
            .unwrap()
            .connections
            .insert(host.to_string(), Connection { client, _process: process });
        log::info!("[host] connected to {host} (server {version})");
        for window in self.windows_on(host) {
            self.sink.emit_to(&window, CONNECTED_EVENT, serde_json::json!({ "host": host }));
        }
        Ok(version)
    }

    /// Whether `host` has a live connection.
    pub fn is_connected(&self, host: &str) -> bool {
        self.state.lock().unwrap().connections.get(host).is_some_and(|c| !c.client.is_closed())
    }

    /// Put `window` on `host` (`None`: back on this computer). A Window
    /// leaving a Host is forgotten there.
    pub fn bind(&self, window: &str, host: Option<&str>) {
        let previous = {
            let mut s = self.state.lock().unwrap();
            match host {
                Some(h) => s.windows.insert(window.to_string(), h.to_string()),
                None => s.windows.remove(window),
            }
        };
        if let Some(prev) = previous.filter(|p| Some(p.as_str()) != host) {
            self.forget_window_on(window, &prev);
        }
    }

    /// The Host `window` is bound to, if any.
    pub fn host_of(&self, window: &str) -> Option<String> {
        self.state.lock().unwrap().windows.get(window).cloned()
    }

    fn windows_on(&self, host: &str) -> Vec<String> {
        let s = self.state.lock().unwrap();
        let mut out: Vec<String> = s.windows.iter().filter(|(_, h)| h.as_str() == host).map(|(w, _)| w.clone()).collect();
        out.sort();
        out
    }

    fn client_of(&self, host: &str) -> Option<Arc<HostClient>> {
        self.state.lock().unwrap().connections.get(host).map(|c| c.client.clone())
    }

    fn forget_window_on(&self, window: &str, host: &str) {
        if let Some(client) = self.client_of(host) {
            client.client_closed(window);
        }
    }

    /// A Window closed: the Host it was on forgets it (its PTYs keep running).
    pub fn window_closed(&self, window: &str) {
        let host = self.state.lock().unwrap().windows.remove(window);
        if let Some(host) = host {
            self.forget_window_on(window, &host);
        }
    }

    /// Run a host command for `window` on `host`, whichever Host the Window
    /// is on (a local Window listing a Host's Profiles before opening one).
    pub fn call_on(&self, host: &str, window: &str, command: &str, args: Value) -> Result<Value, CallError> {
        let Some(client) = self.client_of(host) else {
            return Err(CallError::NotConnected(host.to_string()));
        };
        client.request(window, command, args, None::<Duration>).map_err(|e| match e {
            RequestError::Failed(v) => CallError::Failed(v),
            RequestError::ConnectionLost | RequestError::TimedOut => CallError::ConnectionLost,
        })
    }

    /// Run a host command for `window` on its Host. `None` when the Window is
    /// on this computer (the caller runs it locally).
    pub fn call(&self, window: &str, command: &str, args: Value) -> Option<Result<Value, CallError>> {
        let host = self.host_of(window)?;
        let Some(client) = self.client_of(&host) else {
            return Some(Err(CallError::NotConnected(host)));
        };
        // No time limit: Agent control's waits run through here too.
        Some(client.request(window, command, args, None::<Duration>).map_err(|e| match e {
            RequestError::Failed(v) => CallError::Failed(v),
            RequestError::ConnectionLost | RequestError::TimedOut => CallError::ConnectionLost,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_runs_connect_with_keepalives_and_no_terminal() {
        let t = HostTarget::Ssh { destination: "build-box".into(), server: None };
        let c = t.command();
        assert_eq!(c.get_program(), "ssh");
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            ["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", "build-box", "abundio-server", "connect"]
        );
        // A destination is never read as an option.
        let evil = HostTarget::Ssh { destination: "-oProxyCommand=x".into(), server: None }.command();
        let args: Vec<_> = evil.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[5], "--");
    }

    #[test]
    fn reads_the_targets_the_window_sends() {
        let t: HostTarget = serde_json::from_str(r#"{"kind":"ssh","destination":"me@box"}"#).unwrap();
        assert_eq!(t, HostTarget::Ssh { destination: "me@box".into(), server: None });
        let d: HostTarget = serde_json::from_str(r#"{"kind":"direct","server":"/x/abundio-server","dataDir":"/d"}"#).unwrap();
        assert_eq!(d, HostTarget::Direct { server: "/x/abundio-server".into(), data_dir: Some("/d".into()) });
    }

    struct Nowhere;
    impl WindowSink for Nowhere {
        fn emit_to(&self, _w: &str, _e: &str, _p: Value) {}
        fn pty_frame(&self, _w: &str, _f: &[u8]) {}
    }

    #[test]
    fn a_window_on_this_computer_is_not_routed_and_one_on_a_lost_host_is_told() {
        let router = HostRouter::new(Arc::new(Nowhere));
        assert!(router.call("w", "pty_write", Value::Null).is_none());
        router.bind("w", Some("box"));
        assert_eq!(router.call("w", "pty_write", Value::Null), Some(Err(CallError::NotConnected("box".into()))));
        router.bind("w", None);
        assert!(router.call("w", "pty_write", Value::Null).is_none());
    }
}

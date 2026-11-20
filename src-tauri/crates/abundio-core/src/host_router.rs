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
//!
//! A connection that ends while Windows are on its Host is tried again in
//! the background (phase 7d), with backoff and without ever asking the user
//! anything: a Host that needs a password, a passphrase or a new host key
//! stops the retries and its Windows say "Sign in needed" instead.

use std::collections::{HashMap, HashSet};
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

/// How a connect may ask the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectMode {
    /// Never ask (at app start): ssh fails rather than prompt, and the
    /// Windows say "Sign in needed".
    Batch,
    /// Ask in Abundio's dialog: the environment that points ssh at the
    /// prompt helper (`askpass::Askpass::env`).
    Interactive(Vec<(String, String)>),
}

impl HostTarget {
    /// The program that carries the connection.
    pub fn command(&self, mode: &ConnectMode) -> Command {
        match self {
            HostTarget::Ssh { destination, server } => {
                let mut c = ssh(mode);
                c.arg("--")
                    .arg(destination)
                    .arg(server.as_deref().unwrap_or(DEFAULT_SERVER))
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

    /// `sh -s` on the Host, a script on its stdin and `words` as its
    /// arguments (Host setup). The words reach the Host's shell, so each
    /// must be a plain word (`host_setup::probe_word`). A `Direct` Host runs
    /// it on this computer.
    pub fn shell(&self, mode: &ConnectMode, words: &[&str]) -> Command {
        debug_assert!(words.iter().all(|w| crate::host_setup::probe_word(w) == Some(*w)));
        let mut c = match self {
            HostTarget::Ssh { destination, .. } => {
                let mut c = ssh(mode);
                c.arg("--").arg(destination).args(["sh", "-s", "--"]);
                c
            }
            HostTarget::Direct { .. } => {
                let mut c = Command::new("sh");
                c.args(["-s", "--"]);
                c
            }
        };
        c.args(words);
        c
    }
}

impl HostTarget {
    /// `sh -c <script> abundio-setup <args…>` on the Host, with whatever
    /// the caller writes on its stdin (Host setup's install: the binary).
    /// Over ssh the Host's login shell reads the command line, so the script
    /// and every argument are quoted.
    pub fn sh_c(&self, mode: &ConnectMode, script: &str, args: &[&str]) -> Command {
        match self {
            HostTarget::Ssh { destination, .. } => {
                let mut line = format!("sh -c {} abundio-setup", crate::host_setup::shell_quote(script));
                for a in args {
                    line.push(' ');
                    line.push_str(&crate::host_setup::shell_quote(a));
                }
                let mut c = ssh(mode);
                c.arg("--").arg(destination).arg(line);
                c
            }
            HostTarget::Direct { .. } => {
                let mut c = Command::new("sh");
                c.args(["-c", script, "abundio-setup"]).args(args);
                c
            }
        }
    }
}

/// The server on a Host whose entry names none: whatever is on its PATH
/// (phase 8c points it at the one the app installs).
pub const DEFAULT_SERVER: &str = "abundio-server";

/// The user's `ssh`, with no terminal, keepalives so a dead link is
/// noticed, and their own config for everything else.
fn ssh(mode: &ConnectMode) -> Command {
    let mut c = Command::new("ssh");
    c.args(["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10"]);
    match mode {
        ConnectMode::Batch => {
            c.args(["-o", "BatchMode=yes"]);
        }
        ConnectMode::Interactive(env) => {
            c.envs(env.iter().map(|(k, v)| (k, v)));
        }
    }
    c
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
    /// Which connect made it: a connection that ends after a newer one
    /// replaced it removes nothing.
    generation: u64,
}

#[derive(Default)]
struct State {
    connections: HashMap<String, Connection>,
    /// Window → the Host it is bound to.
    windows: HashMap<String, String>,
    /// How each Host was last reached, for the retries.
    targets: HashMap<String, HostTarget>,
    /// Hosts being tried again in the background.
    retrying: HashSet<String>,
    generation: u64,
}

/// Every Host connection of this desktop app, and which Window is on which.
pub struct HostRouter {
    state: Mutex<State>,
    /// One connect at a time per Host, so a retry and the user's Sign in
    /// never open two connections.
    connecting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    backoff: Mutex<Vec<Duration>>,
    sink: Arc<dyn WindowSink>,
    me: Weak<HostRouter>,
}

/// Told after each failed retry: why, and when the next one is (none when
/// the Host needs the user to sign in).
pub const RECONNECTING_EVENT: &str = "host-reconnecting";

/// The waits between retries; the last one repeats.
pub const BACKOFF: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Whether a failed connect needs the user (a password, a passphrase, 2FA,
/// a host key to trust): trying again without asking only fails again, and
/// a server may lock out an address that keeps failing to log in.
pub fn needs_sign_in(reason: &str) -> bool {
    let r = reason.to_lowercase();
    ["permission denied", "host key verification failed", "too many authentication failures", "no more authentication methods"]
        .iter()
        .any(|m| r.contains(m))
}

/// Told when a connection ends, so its Windows can show it.
pub const CONNECTION_LOST_EVENT: &str = "host-connection-lost";

/// Told when a connection opens, so a Window that loaded before it can load
/// again.
pub const CONNECTED_EVENT: &str = "host-connected";

struct Listener {
    host: String,
    router: Weak<HostRouter>,
    generation: u64,
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
        {
            let mut s = router.state.lock().unwrap();
            if s.connections.get(&self.host).is_none_or(|c| c.generation != self.generation) {
                return;
            }
            s.connections.remove(&self.host);
        }
        let windows = router.windows_on(&self.host);
        if !windows.is_empty() {
            let first = router.backoff.lock().unwrap()[0];
            router.retry_in_background(&self.host, first);
        }
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
        Arc::new_cyclic(|me| HostRouter {
            state: Mutex::default(),
            connecting: Mutex::default(),
            backoff: Mutex::new(BACKOFF.to_vec()),
            sink,
            me: me.clone(),
        })
    }

    /// Shorter waits between retries (tests).
    pub fn set_backoff(&self, waits: Vec<Duration>) {
        assert!(!waits.is_empty());
        *self.backoff.lock().unwrap() = waits;
    }

    /// Connect to `host` (named by the caller, e.g. its ssh destination)
    /// unless already connected. Blocks for the handshake: on a password or
    /// 2FA prompt, until it is answered.
    pub fn connect(&self, host: &str, target: &HostTarget, mode: &ConnectMode) -> Result<String, String> {
        let gate = self.connecting.lock().unwrap().entry(host.to_string()).or_default().clone();
        let _one_at_a_time = gate.lock().unwrap();
        let generation = {
            let mut s = self.state.lock().unwrap();
            s.targets.insert(host.to_string(), target.clone());
            if let Some(c) = s.connections.get(host) {
                if !c.client.is_closed() {
                    return Ok(c.client.server_version.clone());
                }
            }
            s.generation += 1;
            s.generation
        };
        let listener = Arc::new(Listener { host: host.to_string(), router: self.me.clone(), generation });
        let (client, process) = HostProcess::spawn(target.command(mode), listener)?;
        let version = client.server_version.clone();
        self.state
            .lock()
            .unwrap()
            .connections
            .insert(host.to_string(), Connection { client, _process: process, generation });
        log::info!("[host] connected to {host} (server {version})");
        for window in self.windows_on(host) {
            self.sink.emit_to(&window, CONNECTED_EVENT, serde_json::json!({ "host": host }));
        }
        Ok(version)
    }

    /// Try `host` again in the background, first after `first_wait`, then
    /// with backoff, until it connects, needs the user to sign in, or has no
    /// Window left. Once per Host at a time. Its Windows hear each failure
    /// (`host-reconnecting`) and the success (`host-connected`).
    pub fn retry_in_background(&self, host: &str, first_wait: Duration) {
        {
            let mut s = self.state.lock().unwrap();
            if !s.targets.contains_key(host) || !s.retrying.insert(host.to_string()) {
                return;
            }
        }
        let (me, host) = (self.me.clone(), host.to_string());
        std::thread::spawn(move || {
            let mut wait = first_wait;
            let mut attempt = 0usize;
            loop {
                // Sleep in short steps, so a Sign in or the last Window
                // closing ends the wait early.
                let until = std::time::Instant::now() + wait;
                loop {
                    let Some(router) = me.upgrade() else { return };
                    if router.is_connected(&host) || router.windows_on(&host).is_empty() {
                        router.state.lock().unwrap().retrying.remove(&host);
                        return;
                    }
                    drop(router);
                    let now = std::time::Instant::now();
                    if now >= until {
                        break;
                    }
                    std::thread::sleep((until - now).min(Duration::from_millis(200)));
                }
                let Some(router) = me.upgrade() else { return };
                let target = router.state.lock().unwrap().targets.get(&host).cloned();
                let Some(target) = target else {
                    router.state.lock().unwrap().retrying.remove(&host);
                    return;
                };
                match router.connect(&host, &target, &ConnectMode::Batch) {
                    Ok(_) => {
                        router.state.lock().unwrap().retrying.remove(&host);
                        return;
                    }
                    Err(reason) => {
                        let sign_in = needs_sign_in(&reason);
                        wait = {
                            let b = router.backoff.lock().unwrap();
                            b[attempt.min(b.len() - 1)]
                        };
                        attempt += 1;
                        log::info!("[host] {host} is still unreachable ({reason})");
                        for window in router.windows_on(&host) {
                            router.sink.emit_to(
                                &window,
                                RECONNECTING_EVENT,
                                serde_json::json!({
                                    "host": host,
                                    "reason": reason,
                                    "signIn": sign_in,
                                    "retryInMs": if sign_in { None } else { Some(wait.as_millis() as u64) },
                                }),
                            );
                        }
                        if sign_in {
                            router.state.lock().unwrap().retrying.remove(&host);
                            return;
                        }
                    }
                }
            }
        });
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

    /// The Windows on `host`.
    pub fn windows_on(&self, host: &str) -> Vec<String> {
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
        let ask = ConnectMode::Interactive(vec![("SSH_ASKPASS".into(), "/x/helper".into())]);
        let c = t.command(&ask);
        assert_eq!(c.get_program(), "ssh");
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "-T",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ConnectTimeout=10",
                "--",
                "build-box",
                "abundio-server",
                "connect"
            ]
        );
        assert!(c.get_envs().any(|(k, v)| k == "SSH_ASKPASS" && v == Some(std::ffi::OsStr::new("/x/helper"))));
        // At app start ssh never asks.
        let batch = t.command(&ConnectMode::Batch);
        let args: Vec<_> = batch.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(batch.get_envs().next().is_none());
        // A destination is never read as an option.
        let evil = HostTarget::Ssh { destination: "-oProxyCommand=x".into(), server: None }.command(&ask);
        let args: Vec<_> = evil.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[args.len() - 4], "--");
    }

    #[test]
    fn a_setup_script_runs_in_the_hosts_sh_with_plain_words() {
        let t = HostTarget::Ssh { destination: "build-box".into(), server: None };
        let c = t.shell(&ConnectMode::Batch, &["claude", "codex"]);
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(&args[args.len() - 6..], ["build-box", "sh", "-s", "--", "claude", "codex"]);
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
    }

    #[test]
    fn a_setup_script_and_its_arguments_reach_the_host_quoted() {
        let t = HostTarget::Ssh { destination: "build-box".into(), server: None };
        let c = t.sh_c(&ConnectMode::Batch, "echo \"$1\"", &["it's"]);
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(&args[args.len() - 3..], ["--", "build-box", "sh -c 'echo \"$1\"' abundio-setup 'it'\\''s'"]);
        // What the Host's shell makes of that line.
        let out = std::process::Command::new("/bin/sh").args(["-c", &args[args.len() - 1]]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "it's\n");
    }

    #[test]
    fn only_a_failure_the_user_can_fix_stops_the_retries() {
        assert!(needs_sign_in("handshake failed: me@box: Permission denied (publickey,password)."));
        assert!(needs_sign_in("Host key verification failed."));
        assert!(!needs_sign_in("ssh: connect to host box port 22: Operation timed out"));
        assert!(!needs_sign_in("ssh: Could not resolve hostname box: nodename nor servname provided"));
        assert!(!needs_sign_in("handshake failed: the connection ended"));
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

//! The server's end of Host connections (docs/plans/remote-hosts.md phase
//! 7): the `0600` socket in the data folder, one handler per connection
//! (each one desktop app, which speaks for any number of Windows, its
//! Clients), and the event sink that routes events to them.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, BufWriter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use abundio_core::event_sink::{ClientId, EventSink};
use abundio_core::host_protocol::{self, Frame, Message};
use serde_json::Value;

/// Runs one command for one Client: what the server can do (phase 7b fills
/// it with the host commands).
pub type Handler = Arc<dyn Fn(&ClientId, &str, Value) -> Result<Value, Value> + Send + Sync>;

/// Told when a Client is gone (its Window closed, or its connection ended),
/// to forget what it held.
pub type ClientGone = Arc<dyn Fn(&ClientId) + Send + Sync>;

/// PTY output frames a connection may have queued (each at most 16 KB, so
/// about 1 MB) before more are dropped: a slow Client never slows a PTY.
/// It skips ahead instead (phase 9): once its queue is half empty again it
/// gets the pane's screen as a snapshot, and live output from there.
const PTY_QUEUE: usize = 64;

/// How often connections that fell behind are looked at.
const CATCH_UP_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

struct Conn {
    control: crossbeam_channel::Sender<Frame>,
    pty: crossbeam_channel::Sender<Frame>,
    /// The panes this connection fell behind on: their output is dropped for
    /// it until a snapshot is sent.
    behind: Mutex<HashSet<String>>,
}

/// See [`Screens::snapshot`].
pub type SnapshotFn = Box<dyn Fn(&str, &mut dyn FnMut(Vec<u8>)) -> bool + Send + Sync>;

/// What skip-ahead needs from the PTYs.
pub struct Screens {
    /// Hand the callback a pane's screen as bytes, with the pane's output
    /// held back meanwhile (`PtyManager::with_screen_snapshot`); `false`
    /// when there is no such pane.
    pub snapshot: SnapshotFn,
    /// Ask a pane's program to draw again.
    pub redraw: Box<dyn Fn(&str) + Send + Sync>,
}

/// Every open connection and the Clients each speaks for.
#[derive(Default)]
pub struct Connections {
    conns: Mutex<HashMap<u64, Conn>>,
    /// Client → its connection, learnt from the Client's requests.
    clients: Mutex<HashMap<String, u64>>,
    next: AtomicU64,
    screens: std::sync::OnceLock<Screens>,
}

impl Connections {
    fn send_control(&self, conn: u64, frame: Frame) {
        if let Some(c) = self.conns.lock().unwrap().get(&conn) {
            let _ = c.control.send(frame);
        }
    }

    /// Whether `client` speaks on an open connection.
    pub fn has_client(&self, client: &str) -> bool {
        self.conn_of(client).is_some()
    }

    fn conn_of(&self, client: &str) -> Option<u64> {
        self.clients.lock().unwrap().get(client).copied()
    }

    /// Queue PTY output for `client`, dropped when its connection is behind.
    /// Used once Clients subscribe to PTYs (phase 7c).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pty_to_client(&self, client: &ClientId, pty_id: &str, bytes: &[u8]) {
        let Some(conn) = self.conn_of(client.as_str()) else { return };
        if let Some(c) = self.conns.lock().unwrap().get(&conn) {
            let _ = c.pty.try_send(Frame::Pty {
                client: client.as_str().to_string(),
                pty_id: pty_id.to_string(),
                bytes: bytes.to_vec(),
            });
        }
    }

    /// Give skip-ahead the PTYs' screens, and start sending snapshots to
    /// connections that fell behind once they have room again.
    pub fn use_screens(self: &Arc<Self>, screens: Screens) {
        if self.screens.set(screens).is_err() {
            return;
        }
        let me = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("skip-ahead".into())
            .spawn(move || loop {
                std::thread::sleep(CATCH_UP_EVERY);
                let Some(me) = me.upgrade() else { return };
                me.catch_up();
            })
            .expect("skip-ahead thread");
    }

    /// Every connection behind on a pane with room again gets its screen.
    fn catch_up(&self) {
        let Some(screens) = self.screens.get() else { return };
        let due: Vec<(u64, String)> = self
            .conns
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| c.pty.len() <= PTY_QUEUE / 2)
            .flat_map(|(id, c)| c.behind.lock().unwrap().iter().map(|p| (*id, p.clone())).collect::<Vec<_>>())
            .collect();
        for (conn, pty) in due {
            let mut sent = false;
            // Under the pane's screen lock: no output of it is sent until
            // this returns, so the snapshot and what follows join exactly.
            let exists = (screens.snapshot)(&pty, &mut |bytes| {
                let conns = self.conns.lock().unwrap();
                let Some(c) = conns.get(&conn) else { return };
                let frame = Frame::Pty { client: String::new(), pty_id: pty.clone(), bytes };
                if c.pty.try_send(frame).is_ok() {
                    c.behind.lock().unwrap().remove(&pty);
                    sent = true;
                }
            });
            if !exists {
                if let Some(c) = self.conns.lock().unwrap().get(&conn) {
                    c.behind.lock().unwrap().remove(&pty);
                }
            } else if sent {
                log::info!("connection {conn} skipped ahead on {pty}");
                // What a snapshot cannot carry (a scroll region), a
                // full-screen program sets again as it redraws.
                (screens.redraw)(&pty);
            }
        }
    }

    /// The Clients a connection speaks for.
    fn clients_of(&self, conn: u64) -> Vec<String> {
        self.clients.lock().unwrap().iter().filter(|(_, c)| **c == conn).map(|(k, _)| k.clone()).collect()
    }
}

impl EventSink for Connections {
    fn broadcast_value(&self, event: &str, payload: Value) {
        for c in self.conns.lock().unwrap().values() {
            let _ = c.control.send(Frame::Message(Message::Event {
                client: None,
                name: event.to_string(),
                payload: payload.clone(),
            }));
        }
    }

    fn to_client_value(&self, client: &ClientId, event: &str, payload: Value) {
        if let Some(conn) = self.conn_of(client.as_str()) {
            self.send_control(
                conn,
                Frame::Message(Message::Event {
                    client: Some(client.as_str().to_string()),
                    name: event.to_string(),
                    payload,
                }),
            );
        }
    }

    /// Once to every connection: the desktop app puts it in the output
    /// channel of each Window it has on this Host, as local output goes to
    /// every Window. A connection whose queue is full falls behind on this
    /// pane: its output is dropped for it until [`Connections::catch_up`]
    /// sends it the pane's screen. Called with the pane's screen locked.
    fn pty_output(&self, pty_id: &str, data: &[u8]) {
        for (id, c) in self.conns.lock().unwrap().iter() {
            let mut behind = c.behind.lock().unwrap();
            if behind.contains(pty_id) {
                continue;
            }
            let frame = Frame::Pty { client: String::new(), pty_id: pty_id.to_string(), bytes: data.to_vec() };
            if c.pty.try_send(frame).is_err() {
                behind.insert(pty_id.to_string());
                log::info!("connection {id} fell behind on {pty_id}");
            }
        }
    }
}

/// Serve one connection until it ends: the handshake, then each request on
/// a thread of its own (an Agent control wait can take hours), answers and
/// events through one writer.
pub fn serve(
    reader: impl std::io::Read + Send + 'static,
    writer: impl std::io::Write + Send + 'static,
    connections: Arc<Connections>,
    handler: Handler,
    gone: ClientGone,
) {
    let mut reader = BufReader::new(reader);
    let mut writer = BufWriter::new(writer);
    let hello = match Frame::read_from(&mut reader) {
        Ok(Some(Frame::Message(m))) => m,
        _ => return,
    };
    let answer = host_protocol::answer_hello(&hello);
    let refused = matches!(answer, Message::Refused { .. });
    if Frame::Message(answer).write_to(&mut writer).is_err() || refused {
        if refused {
            log::warn!("refused a connection: {hello:?}");
        }
        return;
    }

    let id = connections.next.fetch_add(1, Ordering::SeqCst);
    let (control_tx, control_rx) = crossbeam_channel::unbounded::<Frame>();
    let (pty_tx, pty_rx) = crossbeam_channel::bounded::<Frame>(PTY_QUEUE);
    connections
        .conns
        .lock()
        .unwrap()
        .insert(id, Conn { control: control_tx, pty: pty_tx, behind: Mutex::default() });
    log::info!("a Client connection opened ({id})");

    // One writer: answers and events first, then PTY output.
    let writer_thread = std::thread::spawn(move || loop {
        let frame = crossbeam_channel::select_biased! {
            recv(control_rx) -> f => f,
            recv(pty_rx) -> f => f,
        };
        let Ok(frame) = frame else { break };
        if frame.write_to(&mut writer).is_err() {
            break;
        }
    });

    loop {
        match Frame::read_from(&mut reader) {
            Ok(Some(Frame::Message(Message::Request { id: req, client, command, args }))) => {
                connections.clients.lock().unwrap().insert(client.clone(), id);
                let (connections, handler) = (connections.clone(), handler.clone());
                std::thread::spawn(move || {
                    let (ok, err) = match handler(&ClientId(client), &command, args) {
                        Ok(v) => (Some(v), None),
                        Err(e) => (None, Some(e)),
                    };
                    connections.send_control(id, Frame::Message(Message::Response { id: req, ok, err }));
                });
            }
            Ok(Some(Frame::Message(Message::ClientClosed { client }))) => {
                connections.clients.lock().unwrap().remove(&client);
                gone(&ClientId(client));
            }
            Ok(Some(other)) => log::warn!("unexpected frame from a Client: {other:?}"),
            Ok(None) => break,
            Err(e) => {
                log::warn!("a Client connection broke: {e}");
                break;
            }
        }
    }

    // The desktop app went away: every Window it spoke for is gone.
    for client in connections.clients_of(id) {
        connections.clients.lock().unwrap().remove(&client);
        gone(&ClientId(client));
    }
    connections.conns.lock().unwrap().remove(&id);
    let _ = writer_thread.join();
    log::info!("a Client connection closed ({id})");
}

/// The commands every server answers before phase 7b brings the rest.
pub fn builtin_handler() -> Handler {
    Arc::new(|_client, command, _args| match command {
        "server_ping" => Ok(serde_json::json!({ "version": host_protocol::VERSION })),
        other => Err(Value::String(format!("{other} is not available on this Host yet"))),
    })
}

/// Listen on `path` (made `0600`) and serve each connection on a thread.
#[cfg(unix)]
pub fn listen(
    path: &std::path::Path,
    connections: Arc<Connections>,
    handler: Handler,
    gone: ClientGone,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    // A socket left by a server that died: ours now (we hold the lock).
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| format!("cannot listen on {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("cannot make {} private: {e}", path.display()))?;
    std::thread::Builder::new()
        .name("socket".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let Ok(reader) = stream.try_clone() else { continue };
                let (connections, handler, gone) = (connections.clone(), handler.clone(), gone.clone());
                std::thread::spawn(move || serve(reader, stream, connections, handler, gone));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `abundio-server connect`: carry stdin to the socket and the socket to
/// stdout until either ends. What `ssh <host> abundio-server connect` runs.
#[cfg(unix)]
pub fn connect(path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(path).map_err(|e| format!("no Abundio server is running here ({}: {e})", path.display()))?;
    let mut to_server = stream.try_clone().map_err(|e| e.to_string())?;
    let upstream = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if to_server.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = to_server.shutdown(std::net::Shutdown::Write);
    });
    let mut from_server = stream;
    let mut stdout = std::io::stdout().lock();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match from_server.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
        }
    }
    drop(upstream);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use abundio_core::host_client::{HostClient, HostListener, RequestError};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    #[derive(Default)]
    struct Heard {
        events: Mutex<Vec<(Option<String>, String)>>,
        ptys: Mutex<Vec<(String, String, Vec<u8>)>>,
        closed: Mutex<Option<String>>,
    }

    impl HostListener for Heard {
        fn event(&self, client: Option<&str>, name: &str, _payload: Value) {
            self.events.lock().unwrap().push((client.map(String::from), name.to_string()));
        }
        fn pty(&self, client: &str, pty_id: &str, bytes: &[u8]) {
            self.ptys.lock().unwrap().push((client.into(), pty_id.into(), bytes.to_vec()));
        }
        fn closed(&self, why: &str) {
            *self.closed.lock().unwrap() = Some(why.to_string());
        }
    }

    fn wait_until(mut f: impl FnMut() -> bool) {
        let start = std::time::Instant::now();
        while !f() {
            assert!(start.elapsed() < Duration::from_secs(5), "timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn pair(handler: Handler, gone: ClientGone) -> (Arc<Connections>, Arc<HostClient>, Arc<Heard>) {
        let (a, b) = UnixStream::pair().unwrap();
        let connections = Arc::new(Connections::default());
        {
            let connections = connections.clone();
            let reader = a.try_clone().unwrap();
            std::thread::spawn(move || serve(reader, a, connections, handler, gone));
        }
        let heard = Arc::new(Heard::default());
        let client = HostClient::start(b.try_clone().unwrap(), b, heard.clone()).unwrap();
        (connections, client, heard)
    }

    #[test]
    fn answers_requests_and_routes_events_and_output_to_their_client() {
        let gone_list = Arc::new(Mutex::new(Vec::new()));
        let gone: ClientGone = {
            let g = gone_list.clone();
            Arc::new(move |c: &ClientId| g.lock().unwrap().push(c.as_str().to_string()))
        };
        let (connections, client, heard) = pair(builtin_handler(), gone);
        assert_eq!(client.server_version, host_protocol::VERSION);

        let pong = client.request("w1", "server_ping", Value::Null, Some(Duration::from_secs(5))).unwrap();
        assert_eq!(pong["version"], host_protocol::VERSION);
        let err = client.request("w2", "pty_spawn", Value::Null, Some(Duration::from_secs(5))).unwrap_err();
        assert!(matches!(err, RequestError::Failed(Value::String(ref s)) if s.contains("not available")));

        connections.to_client_value(&ClientId::from("w1"), "status-updates", Value::Null);
        connections.to_client_value(&ClientId::from("nobody"), "lost", Value::Null);
        connections.broadcast_value("tabs-changed", Value::Null);
        connections.pty_to_client(&ClientId::from("w2"), "p", b"out");
        wait_until(|| heard.events.lock().unwrap().len() == 2 && heard.ptys.lock().unwrap().len() == 1);
        assert_eq!(
            *heard.events.lock().unwrap(),
            vec![(Some("w1".into()), "status-updates".into()), (None, "tabs-changed".into())]
        );
        assert_eq!(heard.ptys.lock().unwrap()[0], ("w2".into(), "p".into(), b"out".to_vec()));

        // A Window closes; then the whole app goes.
        client.client_closed("w1");
        wait_until(|| gone_list.lock().unwrap().len() == 1);
        drop(client);
    }

    #[test]
    fn a_slow_request_does_not_hold_up_the_others() {
        let handler: Handler = Arc::new(|_c, command, _a| {
            if command == "slow" {
                std::thread::sleep(Duration::from_millis(500));
            }
            Ok(Value::String(command.to_string()))
        });
        let (_connections, client, _heard) = pair(handler, Arc::new(|_| {}));
        let slow = {
            let client = client.clone();
            std::thread::spawn(move || client.request("w", "slow", Value::Null, None))
        };
        std::thread::sleep(Duration::from_millis(50));
        let start = std::time::Instant::now();
        assert_eq!(client.request("w", "fast", Value::Null, None).unwrap(), "fast");
        assert!(start.elapsed() < Duration::from_millis(300));
        assert_eq!(slow.join().unwrap().unwrap(), "slow");
    }

    #[test]
    fn a_lost_connection_fails_the_waiting_requests_and_forgets_its_clients() {
        let gone_list = Arc::new(Mutex::new(Vec::new()));
        let gone: ClientGone = {
            let g = gone_list.clone();
            Arc::new(move |c: &ClientId| g.lock().unwrap().push(c.as_str().to_string()))
        };
        let (a, b) = UnixStream::pair().unwrap();
        let connections = Arc::new(Connections::default());
        let handler: Handler = Arc::new(|_c, _cmd, _a| {
            std::thread::sleep(Duration::from_secs(60));
            Ok(Value::Null)
        });
        let server_side = a.try_clone().unwrap();
        {
            let connections = connections.clone();
            std::thread::spawn(move || serve(server_side, a, connections, handler, gone));
        }
        let heard = Arc::new(Heard::default());
        let client = HostClient::start(b.try_clone().unwrap(), b.try_clone().unwrap(), heard.clone()).unwrap();
        let waiting = {
            let client = client.clone();
            std::thread::spawn(move || client.request("w", "wait", Value::Null, None))
        };
        wait_until(|| connections.conn_of("w").is_some());
        b.shutdown(std::net::Shutdown::Both).unwrap();
        assert_eq!(waiting.join().unwrap(), Err(RequestError::ConnectionLost));
        wait_until(|| heard.closed.lock().unwrap().is_some());
        wait_until(|| gone_list.lock().unwrap().as_slice() == ["w"]);
        assert_eq!(client.request("w", "x", Value::Null, None), Err(RequestError::ConnectionLost));
    }
}

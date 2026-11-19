//! The desktop's end of one Host connection (docs/plans/remote-hosts.md
//! phase 7): the handshake, requests matched to their answers, and the
//! server's events and PTY output handed to a [`HostListener`].
//!
//! The byte stream is whatever carries it: in the app, the stdin and stdout
//! of `ssh <host> abundio-server connect` ([`HostProcess`]); in tests,
//! `abundio-server connect` run directly, or a socket pair.

use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::host_protocol::{self, Frame, Message};

/// What a connection hears besides answers.
pub trait HostListener: Send + Sync + 'static {
    /// An event for one Client (`Some`) or for every Client of this
    /// connection (`None`).
    fn event(&self, client: Option<&str>, name: &str, payload: Value);
    /// PTY output for one Client.
    fn pty(&self, client: &str, pty_id: &str, bytes: &[u8]);
    /// The connection ended (`why` says how, for the user).
    fn closed(&self, why: &str);
}

/// Why a request failed.
#[derive(Debug, Clone, PartialEq)]
pub enum RequestError {
    /// The command ran and failed: the server's error, as the command
    /// returns it (a string for an `AbundioError`).
    Failed(Value),
    /// The connection ended before the answer came; the command may or may
    /// not have run.
    ConnectionLost,
    /// No answer within the time asked for; the command may still run.
    TimedOut,
}

type Pending = HashMap<u64, crossbeam_channel::Sender<Result<Value, Value>>>;

pub struct HostClient {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Arc<Mutex<Pending>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    /// The server's version, from its welcome.
    pub server_version: String,
}

impl HostClient {
    /// Shake hands over `reader` / `writer`, then hear the server on a
    /// thread of its own. Fails when the server refuses (another build) or
    /// the stream ends first.
    pub fn start(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        listener: Arc<dyn HostListener>,
    ) -> Result<Arc<Self>, String> {
        let mut reader = BufReader::new(reader);
        let mut writer: Box<dyn Write + Send> = Box::new(BufWriter::new(writer));
        Frame::Message(host_protocol::hello())
            .write_to(&mut writer)
            .map_err(|e| format!("cannot reach the server: {e}"))?;
        let server_version = match Frame::read_from(&mut reader) {
            Ok(Some(Frame::Message(Message::Welcome { version, .. }))) => version,
            Ok(Some(Frame::Message(Message::Refused { reason, .. }))) => return Err(reason),
            Ok(Some(_)) => return Err("the server did not answer the handshake".into()),
            Ok(None) => return Err("the connection closed before the server answered".into()),
            Err(e) => return Err(format!("the server's answer could not be read: {e}")),
        };
        let client = Arc::new(Self {
            writer: Mutex::new(writer),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: Arc::new(AtomicBool::new(false)),
            server_version,
        });
        let (pending, closed) = (client.pending.clone(), client.closed.clone());
        std::thread::Builder::new()
            .name("host-reader".into())
            .spawn(move || {
                let why = loop {
                    match Frame::read_from(&mut reader) {
                        Ok(Some(Frame::Message(Message::Response { id, ok, err }))) => {
                            let tx = pending.lock().ok().and_then(|mut p| p.remove(&id));
                            if let Some(tx) = tx {
                                let _ = tx.send(match err {
                                    Some(e) => Err(e),
                                    None => Ok(ok.unwrap_or(Value::Null)),
                                });
                            }
                        }
                        Ok(Some(Frame::Message(Message::Event { client, name, payload }))) => {
                            listener.event(client.as_deref(), &name, payload);
                        }
                        Ok(Some(Frame::Pty { client, pty_id, bytes })) => listener.pty(&client, &pty_id, &bytes),
                        Ok(Some(Frame::Message(m))) => log::warn!("[host] unexpected message from the server: {m:?}"),
                        Ok(None) => break "the connection closed".to_string(),
                        Err(e) => break format!("the connection broke: {e}"),
                    }
                };
                closed.store(true, Ordering::SeqCst);
                // Every request still waiting gets its answer: lost.
                if let Ok(mut p) = pending.lock() {
                    p.clear();
                }
                listener.closed(&why);
            })
            .map_err(|e| e.to_string())?;
        Ok(client)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn send(&self, m: Message) -> io::Result<()> {
        let mut w = self.writer.lock().map_err(|_| io::Error::other("writer poisoned"))?;
        Frame::Message(m).write_to(&mut *w)
    }

    /// Run `command` for `client` on the Host and wait for its answer, at
    /// most `timeout` (`None`: as long as it takes; Agent control's waits
    /// can take hours).
    pub fn request(
        &self,
        client: &str,
        command: &str,
        args: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RequestError> {
        if self.is_closed() {
            return Err(RequestError::ConnectionLost);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.pending.lock().map_err(|_| RequestError::ConnectionLost)?.insert(id, tx);
        let sent = self.send(Message::Request {
            id,
            client: client.to_string(),
            command: command.to_string(),
            args,
        });
        if sent.is_err() {
            self.pending.lock().ok().map(|mut p| p.remove(&id));
            return Err(RequestError::ConnectionLost);
        }
        let answer = match timeout {
            Some(t) => rx.recv_timeout(t).map_err(|e| match e {
                crossbeam_channel::RecvTimeoutError::Timeout => RequestError::TimedOut,
                crossbeam_channel::RecvTimeoutError::Disconnected => RequestError::ConnectionLost,
            }),
            None => rx.recv().map_err(|_| RequestError::ConnectionLost),
        };
        if matches!(answer, Err(RequestError::TimedOut)) {
            self.pending.lock().ok().map(|mut p| p.remove(&id));
        }
        answer?.map_err(RequestError::Failed)
    }

    /// A Window closed: the server forgets what it held for it.
    pub fn client_closed(&self, client: &str) {
        let _ = self.send(Message::ClientClosed { client: client.to_string() });
    }
}

/// The program that carries a connection: `ssh … abundio-server connect`
/// in the app, `abundio-server connect` alone in tests. Its stderr is kept
/// (the last lines) to say why it ended.
pub struct HostProcess {
    child: Mutex<Child>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl HostProcess {
    /// Start `command` and connect over its stdin and stdout.
    pub fn spawn(
        mut command: Command,
        listener: Arc<dyn HostListener>,
    ) -> Result<(Arc<HostClient>, HostProcess), String> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| format!("cannot start {:?}: {e}", command.get_program()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::debug!("[host] {line}");
                    if let Ok(mut t) = tail.lock() {
                        t.push(line);
                        let n = t.len();
                        if n > 20 {
                            t.drain(..n - 20);
                        }
                    }
                }
            });
        }
        let process = HostProcess { child: Mutex::new(child), stderr_tail };
        match HostClient::start(stdout, stdin, listener) {
            Ok(client) => Ok((client, process)),
            Err(e) => {
                // Give the program a moment to say why, then end it.
                std::thread::sleep(Duration::from_millis(100));
                let why = process.stderr_text();
                process.kill();
                Err(if why.is_empty() { e } else { format!("{e}: {why}") })
            }
        }
    }

    /// What the program printed last on stderr.
    pub fn stderr_text(&self) -> String {
        self.stderr_tail.lock().map(|t| t.join("\n")).unwrap_or_default()
    }

    pub fn kill(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

//! The protocol between the desktop app and an Abundio server
//! (docs/plans/remote-hosts.md phase 7, ADR-0062).
//!
//! One byte stream per Host (the `ssh <host> abundio-server connect`
//! channel) carries everything, as frames:
//!
//! ```text
//! u32 length (big-endian, of what follows) | u8 kind | payload
//! ```
//!
//! - kind 0, [`Message`]: JSON. The handshake, requests and their answers,
//!   events.
//! - kind 1, PTY output: `u16 length | client id | u16 length | pty id |
//!   bytes`, raw, never base64.
//!
//! The first frame each way is the handshake: the desktop's [`Message::Hello`],
//! the server's [`Message::Welcome`] or [`Message::Refused`]. Both sides must
//! be the same build (`VERSION`) and speak the same `PROTOCOL`; there is no
//! compatibility path (ADR-0062: "an older or newer server is never spoken
//! to").

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped on any change to the frames or messages.
pub const PROTOCOL: u32 = 1;

/// The build: the server's must equal the app's.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// No frame is larger: a length past it is a broken stream, not a message.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

const KIND_MESSAGE: u8 = 0;
const KIND_PTY: u8 = 1;

/// One JSON message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Message {
    /// Desktop → server, first: who is speaking.
    Hello { version: String, protocol: u32 },
    /// Server → desktop: the handshake succeeded.
    Welcome { version: String, protocol: u32 },
    /// Server → desktop: the handshake failed; the server closes after it.
    Refused { reason: String, version: String, protocol: u32 },
    /// Desktop → server: run `command` for `client` (a Window), with the
    /// arguments the Window passed.
    Request { id: u64, client: String, command: String, args: Value },
    /// Server → desktop: the answer to request `id`: `ok` or `err`.
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ok: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        err: Option<Value>,
    },
    /// Server → desktop: an event for one Client, or (no `client`) for
    /// every Client of this connection.
    Event {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client: Option<String>,
        name: String,
        payload: Value,
    },
    /// Desktop → server: a Window closed; forget what it held.
    ClientClosed { client: String },
}

/// One frame, read or to write.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Message(Message),
    Pty { client: String, pty_id: String, bytes: Vec<u8> },
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

impl Frame {
    /// The frame as bytes on the wire.
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let mut body = Vec::new();
        match self {
            Frame::Message(m) => {
                body.push(KIND_MESSAGE);
                serde_json::to_writer(&mut body, m).map_err(|e| invalid(e.to_string()))?;
            }
            Frame::Pty { client, pty_id, bytes } => {
                body.push(KIND_PTY);
                for s in [client, pty_id] {
                    let len = u16::try_from(s.len()).map_err(|_| invalid("id too long"))?;
                    body.extend_from_slice(&len.to_be_bytes());
                    body.extend_from_slice(s.as_bytes());
                }
                body.extend_from_slice(bytes);
            }
        }
        if body.len() > MAX_FRAME {
            return Err(invalid("frame too large"));
        }
        let mut out = Vec::with_capacity(4 + body.len());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        Ok(out)
    }

    pub fn write_to(&self, w: &mut impl Write) -> io::Result<()> {
        w.write_all(&self.encode()?)?;
        w.flush()
    }

    /// Read the next frame; `None` at a clean end of stream (between frames).
    pub fn read_from(r: &mut impl Read) -> io::Result<Option<Frame>> {
        let mut len = [0u8; 4];
        match r.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_FRAME {
            return Err(invalid(format!("bad frame length {len}")));
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        Self::decode(&body).map(Some)
    }

    fn decode(body: &[u8]) -> io::Result<Frame> {
        match body[0] {
            KIND_MESSAGE => serde_json::from_slice(&body[1..])
                .map(Frame::Message)
                .map_err(|e| invalid(format!("bad message: {e}"))),
            KIND_PTY => {
                let mut at = 1;
                let mut take = || -> io::Result<String> {
                    let len_bytes = body.get(at..at + 2).ok_or_else(|| invalid("short pty frame"))?;
                    let len = u16::from_be_bytes([len_bytes[0], len_bytes[1]]) as usize;
                    let s = body.get(at + 2..at + 2 + len).ok_or_else(|| invalid("short pty frame"))?;
                    at += 2 + len;
                    String::from_utf8(s.to_vec()).map_err(|_| invalid("pty frame id is not UTF-8"))
                };
                let client = take()?;
                let pty_id = take()?;
                Ok(Frame::Pty { client, pty_id, bytes: body[at..].to_vec() })
            }
            k => Err(invalid(format!("unknown frame kind {k}"))),
        }
    }
}

/// The desktop's opening message.
pub fn hello() -> Message {
    Message::Hello { version: VERSION.to_string(), protocol: PROTOCOL }
}

/// The server's answer to `hello`: `Welcome` when it is the same build and
/// protocol, `Refused` (saying why) otherwise.
pub fn answer_hello(hello: &Message) -> Message {
    let refuse = |reason: String| Message::Refused {
        reason,
        version: VERSION.to_string(),
        protocol: PROTOCOL,
    };
    match hello {
        Message::Hello { version, protocol } if *protocol != PROTOCOL || version != VERSION => refuse(format!(
            "this Abundio server is version {VERSION} (protocol {PROTOCOL}); the app is {version} (protocol {protocol})"
        )),
        Message::Hello { .. } => Message::Welcome { version: VERSION.to_string(), protocol: PROTOCOL },
        _ => refuse("the first message must be a hello".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(f: Frame) {
        let bytes = f.encode().unwrap();
        let mut r = io::Cursor::new(bytes);
        assert_eq!(Frame::read_from(&mut r).unwrap(), Some(f));
        assert_eq!(Frame::read_from(&mut r).unwrap(), None);
    }

    #[test]
    fn frames_survive_the_wire() {
        roundtrip(Frame::Message(hello()));
        roundtrip(Frame::Message(Message::Request {
            id: 7,
            client: "window-1".into(),
            command: "pty_write".into(),
            args: serde_json::json!({ "ptyId": "p", "data": [1, 2] }),
        }));
        roundtrip(Frame::Message(Message::Response { id: 7, ok: None, err: Some("nope".into()) }));
        roundtrip(Frame::Message(Message::Event { client: None, name: "x".into(), payload: Value::Null }));
        roundtrip(Frame::Pty { client: "w".into(), pty_id: "p".into(), bytes: vec![0, 0x1b, 0xff] });
        roundtrip(Frame::Pty { client: "w".into(), pty_id: "p".into(), bytes: vec![] });
    }

    #[test]
    fn reads_frames_back_to_back_and_split_across_reads() {
        let a = Frame::Message(hello()).encode().unwrap();
        let b = Frame::Pty { client: "w".into(), pty_id: "p".into(), bytes: b"hi".to_vec() }.encode().unwrap();
        // A reader that hands out one byte at a time.
        struct Trickle(Vec<u8>, usize);
        impl Read for Trickle {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.1 >= self.0.len() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }
        let mut r = Trickle([a, b].concat(), 0);
        assert!(matches!(Frame::read_from(&mut r).unwrap(), Some(Frame::Message(Message::Hello { .. }))));
        assert!(matches!(Frame::read_from(&mut r).unwrap(), Some(Frame::Pty { .. })));
        assert!(Frame::read_from(&mut r).unwrap().is_none());
    }

    #[test]
    fn refuses_a_broken_stream() {
        assert!(Frame::read_from(&mut io::Cursor::new(vec![0, 0, 0, 0])).is_err());
        assert!(Frame::read_from(&mut io::Cursor::new(vec![0xff, 0xff, 0xff, 0xff])).is_err());
        assert!(Frame::read_from(&mut io::Cursor::new(vec![0, 0, 0, 1, 9])).is_err());
        assert!(Frame::read_from(&mut io::Cursor::new(vec![0, 0, 0, 3, 1, 0, 9])).is_err());
        // Ended inside a frame.
        assert!(Frame::read_from(&mut io::Cursor::new(vec![0, 0, 0, 9, 0])).is_err());
    }

    #[test]
    fn speaks_only_to_the_same_build() {
        assert!(matches!(answer_hello(&hello()), Message::Welcome { .. }));
        let older = Message::Hello { version: "0.0.1".into(), protocol: PROTOCOL };
        let Message::Refused { reason, .. } = answer_hello(&older) else { panic!() };
        assert!(reason.contains("0.0.1"), "{reason}");
        let other = Message::Hello { version: VERSION.into(), protocol: PROTOCOL + 1 };
        assert!(matches!(answer_hello(&other), Message::Refused { .. }));
        assert!(matches!(answer_hello(&Message::ClientClosed { client: "w".into() }), Message::Refused { .. }));
    }
}

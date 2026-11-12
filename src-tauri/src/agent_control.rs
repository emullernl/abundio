//! **Agent control** (ADR-0054): an Agent in one Pane driving other Panes of
//! its Workspace through the `abundio` command.
//!
//! Rust checks and routes; the Window carries the call out. A request arrives
//! on the hook server's `/control` route with the caller's per-pane token. The
//! token alone says who is calling ([`ControlTokens`]); the request's argv is
//! parsed here ([`parse_args`]), the setting is checked, and the request is
//! sent to the Window that owns the caller's Workspace as an
//! `agent-control-request` event. The Window answers with the
//! `agent_control_reply` command, which completes the waiting HTTP thread
//! ([`PendingRequests`]).
//!
//! Every wait passes through here, so Rust keeps the graph of who is waiting
//! on whom ([`WaitGraph`]) and refuses a wait that would close a loop.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, Sender};
use dashmap::DashMap;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

// ── Callers and their tokens ──

/// Who made an Agent control call: the PTY whose token it carried.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    pub pty_id: String,
    pub pane_id: String,
    pub workspace_id: String,
    /// The Window that spawned the PTY, which owns its Workspace.
    #[serde(skip)]
    pub window_label: String,
}

/// Per-PTY Agent control tokens. One is issued at spawn and given to the PTY
/// as `ABUNDIO_AGENT_TOKEN`; it is revoked when the PTY exits or is killed.
/// Unlike the hook token, it differs in every PTY, which is what makes "only
/// the app's own Panes, only their own Workspace" real.
///
/// Lookup is by hash, not a constant-time compare. The token is 256 random
/// bits; a hash-map probe leaks nothing that would let a caller guess it a
/// byte at a time.
#[derive(Default)]
pub struct ControlTokens {
    by_token: DashMap<String, Caller>,
    by_pty: DashMap<String, String>,
}

impl ControlTokens {
    /// The Window holding `workspace_id`, read off any live PTY of it: a
    /// Workspace is Opened in at most one Window. None when no PTY of it
    /// lives, which means it is not Opened.
    pub fn window_for_workspace(&self, workspace_id: &str) -> Option<String> {
        self.by_token
            .iter()
            .find(|e| e.value().workspace_id == workspace_id)
            .map(|e| e.value().window_label.clone())
    }

    /// Issue a token for `caller`, replacing any earlier token of its PTY.
    pub fn issue(&self, caller: Caller) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        if let Some((_, old)) = self.by_pty.remove(&caller.pty_id) {
            self.by_token.remove(&old);
        }
        self.by_pty.insert(caller.pty_id.clone(), token.clone());
        self.by_token.insert(token.clone(), caller);
        token
    }

    pub fn lookup(&self, token: &str) -> Option<Caller> {
        self.by_token.get(token).map(|c| c.clone())
    }

    /// Revoke whatever token the PTY holds (it was killed).
    pub fn revoke_pty(&self, pty_id: &str) {
        if let Some((_, token)) = self.by_pty.remove(pty_id) {
            self.by_token.remove(&token);
        }
    }

    /// Revoke one specific token (its PTY exited). A newer token issued to the
    /// same pty id since then is left alone.
    pub fn revoke_token(&self, token: &str) {
        if let Some((_, caller)) = self.by_token.remove(token) {
            self.by_pty
                .remove_if(&caller.pty_id, |_, current| current == token);
        }
    }
}

// ── Requests waiting for their Window's reply ──

#[derive(Default)]
pub struct PendingRequests {
    waiting: DashMap<String, Sender<Value>>,
}

impl PendingRequests {
    pub fn register(&self) -> (String, Receiver<Value>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = bounded(1);
        self.waiting.insert(id.clone(), tx);
        (id, rx)
    }

    /// Deliver a Window's reply. `false` if nothing waits for it any more (it
    /// timed out, or the id is unknown).
    pub fn complete(&self, id: &str, reply: Value) -> bool {
        match self.waiting.remove(id) {
            Some((_, tx)) => tx.try_send(reply).is_ok(),
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        self.waiting.remove(id);
    }
}

// ── Who waits on whom ──

/// Open waits, as edges from the waiting pane to the pane it waits on. A pane
/// may hold several waits at once (an Agent can run commands in the
/// background), so edges are kept per wait id.
#[derive(Default)]
pub struct WaitGraph {
    edges: Mutex<HashMap<String, (String, String)>>,
}

impl WaitGraph {
    /// Add the wait `id` from `from` to `to` and return `true`, unless it would close a loop:
    /// `to` already waits, directly or through others, on `from`. Waiting on
    /// yourself is a loop too.
    pub fn try_add(&self, id: &str, from: &str, to: &str) -> bool {
        let mut edges = self.edges.lock().unwrap();
        if reaches(&edges, to, from) {
            return false;
        }
        edges.insert(id.to_string(), (from.to_string(), to.to_string()));
        true
    }

    pub fn remove(&self, id: &str) {
        self.edges.lock().unwrap().remove(id);
    }
}

/// Whether `target` can be reached from `start` by following wait edges.
fn reaches(edges: &HashMap<String, (String, String)>, start: &str, target: &str) -> bool {
    let mut stack = vec![start.to_string()];
    let mut seen = std::collections::HashSet::new();
    while let Some(node) = stack.pop() {
        if node == target {
            return true;
        }
        if !seen.insert(node.clone()) {
            continue;
        }
        for (from, to) in edges.values() {
            if *from == node {
                stack.push(to.clone());
            }
        }
    }
    false
}

// ── The command line ──

/// A pane addressed by an Agent: its **Pane number** or its Agent's
/// **Agent handle**.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Target {
    Pane(u32),
    Handle(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Right,
    Down,
}

/// What `agent wait --until` waits for. `Settled` is Ready, Waiting or Error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Until {
    Settled,
    Ready,
    Waiting,
    Error,
}

/// One parsed `abundio` call. Serialised as the `request` of an
/// `agent-control-request` event, tagged by `op`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    #[serde(rename = "pane.list")]
    PaneList,
    #[serde(rename = "pane.current")]
    PaneCurrent,
    #[serde(rename = "pane.read", rename_all = "camelCase")]
    PaneRead {
        target: Target,
        lines: Option<u32>,
        visible: bool,
    },
    #[serde(rename = "pane.split", rename_all = "camelCase")]
    PaneSplit {
        direction: Option<Direction>,
        focus: bool,
    },
    #[serde(rename = "pane.run", rename_all = "camelCase")]
    PaneRun { target: Target, command: String },
    #[serde(rename = "pane.close", rename_all = "camelCase")]
    PaneClose { target: Target },
    #[serde(rename = "agent.list")]
    AgentList,
    #[serde(rename = "agent.start", rename_all = "camelCase")]
    AgentStart {
        handle: Option<String>,
        kind: String,
        prompt: Option<String>,
        direction: Option<Direction>,
        args: Vec<String>,
        /// Move keyboard focus to the new pane. Off by default: the user is
        /// usually typing to the caller.
        focus: bool,
        /// Open it in a new **Spawned tab** instead of splitting the caller.
        tab: bool,
        /// The new Tab's name (only with `tab`); else a default.
        tab_name: Option<String>,
    },
    #[serde(rename = "agent.prompt", rename_all = "camelCase")]
    AgentPrompt {
        target: Target,
        text: String,
        wait: bool,
        /// `None` means no limit. Filled with the default by [`parse_args`].
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "agent.wait", rename_all = "camelCase")]
    AgentWait {
        target: Target,
        until: Until,
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "agent.sendKeys", rename_all = "camelCase")]
    AgentSendKeys { target: Target, keys: Vec<String> },
    #[serde(rename = "agent.rename", rename_all = "camelCase")]
    AgentRename {
        target: Target,
        handle: Option<String>,
    },
    /// A shell in a new **Spawned tab**.
    #[serde(rename = "tab.new", rename_all = "camelCase")]
    TabNew { name: Option<String>, focus: bool },
    /// Rename the caller's own Tab (`target: None`), or the Tab holding
    /// `target`'s pane.
    #[serde(rename = "tab.rename", rename_all = "camelCase")]
    TabRename { name: String, target: Option<Target> },
    /// Every Workspace of the caller's Profile. Answered by Rust alone.
    #[serde(rename = "workspace.list")]
    WorkspaceList,
}

/// What a command line asks for: a request, or help text.
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Request(Request),
    Help(String),
}

/// Default limit for `--wait` calls: 30 minutes.
pub const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30 * 60 * 1000;

/// How long a call that does not wait may take before the Window counts as
/// unresponsive. `agent start` waits for the Agent to come up (30 s), so this
/// is a little longer.
pub const PLAIN_REPLY_TIMEOUT: Duration = Duration::from_secs(45);

/// Whether `s` is a valid **Agent handle**: `[a-z][a-z0-9_-]{0,31}`, and never
/// shaped like a Pane number (`p` then digits only), so the two cannot clash.
/// An Agent handle as stored and shown (ADR-0055), or None when `s` is not
/// one: trimmed, inner runs of spaces made one, 1–32 characters, starting
/// with a letter, then ASCII letters, digits, spaces, `-` and `_`; never
/// anything that reads as a Pane number (`p3`, `P3`, `p007`).
pub fn normalize_handle(s: &str) -> Option<String> {
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    let name = s.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let len = name.chars().count();
    if len == 0 || len > 32 {
        return None;
    }
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    // `p0` and `p007` are not valid Pane numbers, but they look like one.
    if matches!(lower.strip_prefix('p'), Some(d) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some(name)
}

/// Whether `s` is already a handle in its stored form.
pub fn valid_handle(s: &str) -> bool {
    normalize_handle(s).as_deref() == Some(s)
}

/// The form handles are matched and kept unique by: lowercase, with every
/// run of spaces and dashes made one `-`. "Agent Two", "agent-two" and
/// "AGENT  two" are the same handle.
pub fn handle_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.trim().chars() {
        if c == ' ' || c == '-' {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push('-');
        }
        gap = false;
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// `p12` → 12. Anything else, including `p0` and `p`, is not a Pane number.
fn parse_pane_number(s: &str) -> Option<u32> {
    let digits = s.strip_prefix('p').or_else(|| s.strip_prefix('P'))?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|n| *n > 0)
}

fn parse_target(s: &str) -> Result<Target, String> {
    if let Some(n) = parse_pane_number(s) {
        return Ok(Target::Pane(n));
    }
    if let Some(h) = normalize_handle(s) {
        return Ok(Target::Handle(h));
    }
    Err(format!(
        "{s:?} is neither a Pane number (p1, p2, …) nor an Agent handle"
    ))
}

/// The logical key names `agent send-keys` accepts.
pub fn valid_key(s: &str) -> bool {
    const NAMED: &[&str] = &[
        "enter", "esc", "tab", "shift+tab", "backspace", "delete", "space", "up", "down", "left",
        "right", "home", "end", "pageup", "pagedown",
    ];
    if NAMED.contains(&s) {
        return true;
    }
    match s.strip_prefix("ctrl+") {
        Some(rest) => rest.len() == 1 && rest.as_bytes()[0].is_ascii_lowercase(),
        None => false,
    }
}

fn parse_direction(s: &str) -> Result<Direction, String> {
    match s {
        "right" => Ok(Direction::Right),
        "down" => Ok(Direction::Down),
        _ => Err(format!("--direction must be right or down, not {s:?}")),
    }
}

/// `--timeout <ms>`: `0` means no limit.
fn parse_timeout(s: &str) -> Result<Option<u64>, String> {
    match s.parse::<u64>() {
        Ok(0) => Ok(None),
        Ok(ms) => Ok(Some(ms)),
        Err(_) => Err(format!("--timeout takes milliseconds, not {s:?}")),
    }
}

/// Splits a command's arguments into positionals and flags. Flags in
/// `with_value` take the next argument; the rest are switches. After `--`,
/// everything is positional and is returned separately.
struct Args<'a> {
    positional: Vec<&'a str>,
    flags: HashMap<&'static str, Option<&'a str>>,
    passthrough: Vec<&'a str>,
}

fn split_args<'a>(
    args: &'a [String],
    with_value: &[&'static str],
    switches: &[&'static str],
) -> Result<Args<'a>, String> {
    let mut out = Args {
        positional: Vec::new(),
        flags: HashMap::new(),
        passthrough: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            out.passthrough = args[i + 1..].iter().map(String::as_str).collect();
            break;
        }
        if let Some(name) = with_value.iter().find(|f| **f == a) {
            let value = args
                .get(i + 1)
                .ok_or_else(|| format!("{a} needs a value"))?;
            out.flags.insert(name, Some(value.as_str()));
            i += 2;
            continue;
        }
        if let Some(name) = switches.iter().find(|f| **f == a) {
            out.flags.insert(name, None);
            i += 1;
            continue;
        }
        if a.starts_with("--") {
            return Err(format!("unknown option {a}"));
        }
        out.positional.push(a);
        i += 1;
    }
    Ok(out)
}

fn expect_positionals(args: &Args, min: usize, max: usize, usage: &str) -> Result<(), String> {
    let n = args.positional.len();
    if n < min || n > max {
        return Err(format!("usage: {usage}"));
    }
    Ok(())
}

/// Parse an `abundio` command line (without the program name). An `Err` is a
/// usage error, which the CLI reports with exit code 2.
pub fn parse_args(argv: &[String]) -> Result<Parsed, String> {
    let group = argv.first().map(String::as_str);
    let command = argv.get(1).map(String::as_str);
    let rest = if argv.len() > 2 { &argv[2..] } else { &[] };
    match (group, command) {
        (None, _) | (Some("help" | "--help" | "-h"), None) => Ok(Parsed::Help(help(None))),
        (Some("help"), Some(g)) => Ok(Parsed::Help(help(Some(g)))),
        (Some(g @ ("pane" | "agent" | "tab" | "workspace")), None | Some("--help" | "-h" | "help")) => {
            Ok(Parsed::Help(help(Some(g))))
        }
        (Some("pane"), Some(c)) => parse_pane(c, rest).map(Parsed::Request),
        (Some("agent"), Some(c)) => parse_agent(c, rest).map(Parsed::Request),
        (Some("tab"), Some(c)) => parse_tab(c, rest).map(Parsed::Request),
        (Some("workspace"), Some("list")) => {
            if !rest.is_empty() {
                return Err("usage: abundio workspace list".into());
            }
            Ok(Parsed::Request(Request::WorkspaceList))
        }
        (Some("workspace"), Some(c)) => Err(format!(
            "unknown command `workspace {c}`; run `abundio help workspace`"
        )),
        (Some(g), _) => Err(format!("unknown command {g:?}; run `abundio help`")),
    }
}

fn parse_pane(command: &str, rest: &[String]) -> Result<Request, String> {
    match command {
        "list" | "current" => {
            let a = split_args(rest, &[], &[])?;
            expect_positionals(&a, 0, 0, &format!("abundio pane {command}"))?;
            Ok(if command == "list" {
                Request::PaneList
            } else {
                Request::PaneCurrent
            })
        }
        "read" => {
            let usage = "abundio pane read <pane> [--lines N] [--visible]";
            let a = split_args(rest, &["--lines"], &["--visible"])?;
            expect_positionals(&a, 1, 1, usage)?;
            let lines = match a.flags.get("--lines").copied().flatten() {
                Some(v) => Some(
                    v.parse::<u32>()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| format!("--lines takes a positive number, not {v:?}"))?,
                ),
                None => None,
            };
            Ok(Request::PaneRead {
                target: parse_target(a.positional[0])?,
                lines,
                visible: a.flags.contains_key("--visible"),
            })
        }
        "split" => {
            let a = split_args(rest, &["--direction"], &["--focus"])?;
            expect_positionals(&a, 0, 0, "abundio pane split [--direction right|down] [--focus]")?;
            Ok(Request::PaneSplit {
                direction: a
                    .flags
                    .get("--direction")
                    .copied()
                    .flatten()
                    .map(parse_direction)
                    .transpose()?,
                focus: a.flags.contains_key("--focus"),
            })
        }
        "run" => {
            let a = split_args(rest, &[], &[])?;
            expect_positionals(&a, 2, 2, "abundio pane run <pane> <command>")?;
            let command = a.positional[1];
            if command.trim().is_empty() {
                return Err("the command is empty".into());
            }
            if command.contains('\n') || command.contains('\r') {
                return Err("the command must be one line".into());
            }
            Ok(Request::PaneRun {
                target: parse_target(a.positional[0])?,
                command: command.to_string(),
            })
        }
        "close" => {
            let a = split_args(rest, &[], &[])?;
            expect_positionals(&a, 1, 1, "abundio pane close <pane>")?;
            Ok(Request::PaneClose {
                target: parse_target(a.positional[0])?,
            })
        }
        other => Err(format!(
            "unknown command `pane {other}`; run `abundio help pane`"
        )),
    }
}

fn parse_agent(command: &str, rest: &[String]) -> Result<Request, String> {
    match command {
        "list" => {
            let a = split_args(rest, &[], &[])?;
            expect_positionals(&a, 0, 0, "abundio agent list")?;
            Ok(Request::AgentList)
        }
        "start" => {
            let usage = "abundio agent start --kind <agent> [--handle <h>] [--prompt <text>] [--direction right|down | --tab [--tab-name <name>]] [--focus] [-- <agent args>]";
            let a = split_args(
                rest,
                &["--kind", "--handle", "--prompt", "--direction", "--tab-name"],
                &["--focus", "--tab"],
            )?;
            let tab = a.flags.contains_key("--tab");
            let tab_name = match a.flags.get("--tab-name").copied().flatten() {
                Some(_) if !tab => return Err("--tab-name needs --tab".into()),
                Some(n) => Some(check_tab_name(n)?),
                None => None,
            };
            if tab && a.flags.contains_key("--direction") {
                return Err("--direction is for a split; a new Tab has none".into());
            }
            expect_positionals(&a, 0, 0, usage)?;
            let kind = a
                .flags
                .get("--kind")
                .copied()
                .flatten()
                .ok_or_else(|| format!("--kind is required; usage: {usage}"))?;
            if kind.is_empty() {
                return Err("--kind is empty".into());
            }
            let handle = match a.flags.get("--handle").copied().flatten() {
                Some(h) => Some(normalize_handle(h).ok_or_else(|| invalid_handle(h))?),
                None => None,
            };
            if a.passthrough.iter().any(|s| s.chars().any(char::is_control)) {
                return Err("agent arguments must not contain control characters".into());
            }
            Ok(Request::AgentStart {
                handle,
                kind: kind.to_string(),
                prompt: a.flags.get("--prompt").copied().flatten().map(str::to_string),
                direction: a
                    .flags
                    .get("--direction")
                    .copied()
                    .flatten()
                    .map(parse_direction)
                    .transpose()?,
                args: a.passthrough.iter().map(|s| s.to_string()).collect(),
                focus: a.flags.contains_key("--focus"),
                tab,
                tab_name,
            })
        }
        "prompt" => {
            let usage = "abundio agent prompt <agent> <text> [--wait] [--timeout <ms>]";
            let a = split_args(rest, &["--timeout"], &["--wait"])?;
            expect_positionals(&a, 2, 2, usage)?;
            if a.positional[1].trim().is_empty() {
                return Err("the prompt is empty".into());
            }
            let wait = a.flags.contains_key("--wait");
            let timeout_ms = match a.flags.get("--timeout").copied().flatten() {
                Some(_) if !wait => return Err("--timeout needs --wait".into()),
                Some(v) => parse_timeout(v)?,
                None => Some(DEFAULT_WAIT_TIMEOUT_MS),
            };
            Ok(Request::AgentPrompt {
                target: parse_target(a.positional[0])?,
                text: a.positional[1].to_string(),
                wait,
                timeout_ms: if wait { timeout_ms } else { None },
            })
        }
        "wait" => {
            let usage =
                "abundio agent wait <agent> [--until settled|ready|waiting|error] [--timeout <ms>]";
            let a = split_args(rest, &["--until", "--timeout"], &[])?;
            expect_positionals(&a, 1, 1, usage)?;
            let until = match a.flags.get("--until").copied().flatten() {
                None | Some("settled") => Until::Settled,
                Some("ready") => Until::Ready,
                Some("waiting") => Until::Waiting,
                Some("error") => Until::Error,
                Some(other) => {
                    return Err(format!(
                        "--until must be settled, ready, waiting or error, not {other:?}"
                    ))
                }
            };
            Ok(Request::AgentWait {
                target: parse_target(a.positional[0])?,
                until,
                timeout_ms: match a.flags.get("--timeout").copied().flatten() {
                    Some(v) => parse_timeout(v)?,
                    None => Some(DEFAULT_WAIT_TIMEOUT_MS),
                },
            })
        }
        "send-keys" => {
            let a = split_args(rest, &[], &[])?;
            if a.positional.len() < 2 {
                return Err("usage: abundio agent send-keys <agent|pane> <key>...".into());
            }
            // Every key is checked before any is sent.
            if let Some(bad) = a.positional[1..].iter().find(|k| !valid_key(k)) {
                return Err(format!(
                    "unknown key {bad:?}; keys are enter, esc, tab, shift+tab, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown and ctrl+<letter>"
                ));
            }
            Ok(Request::AgentSendKeys {
                target: parse_target(a.positional[0])?,
                keys: a.positional[1..].iter().map(|s| s.to_string()).collect(),
            })
        }
        "rename" => {
            let a = split_args(rest, &[], &[])?;
            expect_positionals(&a, 1, 2, "abundio agent rename <agent> [<handle>]")?;
            let handle = match a.positional.get(1) {
                Some(h) => Some(normalize_handle(h).ok_or_else(|| invalid_handle(h))?),
                None => None,
            };
            Ok(Request::AgentRename {
                target: parse_target(a.positional[0])?,
                handle,
            })
        }
        other => Err(format!(
            "unknown command `agent {other}`; run `abundio help agent`"
        )),
    }
}

/// The longest Tab name an Agent may set, in characters.
pub const TAB_NAME_MAX: usize = 64;

/// A Tab name an Agent gives: trimmed, one line, no control characters,
/// 1–[`TAB_NAME_MAX`] characters.
fn check_tab_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("the Tab name is empty".into());
    }
    if name.chars().any(char::is_control) {
        return Err("a Tab name must be one line with no control characters".into());
    }
    if name.chars().count() > TAB_NAME_MAX {
        return Err(format!("a Tab name can have at most {TAB_NAME_MAX} characters"));
    }
    Ok(name.to_string())
}

fn parse_tab(command: &str, rest: &[String]) -> Result<Request, String> {
    match command {
        "new" => {
            let a = split_args(rest, &["--name"], &["--focus"])?;
            expect_positionals(&a, 0, 0, "abundio tab new [--name <name>] [--focus]")?;
            Ok(Request::TabNew {
                name: a
                    .flags
                    .get("--name")
                    .copied()
                    .flatten()
                    .map(check_tab_name)
                    .transpose()?,
                focus: a.flags.contains_key("--focus"),
            })
        }
        "rename" => {
            let a = split_args(rest, &["--tab"], &[])?;
            expect_positionals(&a, 1, 1, "abundio tab rename <name> [--tab <pane|agent>]")?;
            Ok(Request::TabRename {
                name: check_tab_name(a.positional[0])?,
                target: a
                    .flags
                    .get("--tab")
                    .copied()
                    .flatten()
                    .map(parse_target)
                    .transpose()?,
            })
        }
        other => Err(format!(
            "unknown command `tab {other}`; run `abundio help tab`"
        )),
    }
}

fn invalid_handle(h: &str) -> String {
    format!(
        "{h:?} is not a valid Agent handle: up to 32 characters, starting with a letter, then letters, digits, spaces, '-' or '_', and not p followed by digits (that is a Pane number)"
    )
}

fn help(group: Option<&str>) -> String {
    const PANE: &str = "\
Panes (only those of your own Workspace):
  abundio pane list                       every pane, with its number, Agent and status
  abundio pane current                    the pane you are running in
  abundio pane read <pane> [--lines N] [--visible]
                                          the pane's text as drawn
  abundio pane split [--direction right|down] [--focus]
                                          a new shell pane beside yours
  abundio pane run <pane> <command>       run a one-line command in an idle shell
  abundio pane close <pane>               close a pane you created
";
    const AGENT: &str = "\
Agents:
  abundio agent list                      every Agent in your Workspace
  abundio agent start --kind <agent> [--handle <h>] [--prompt <text>]
                      [--direction right|down | --tab [--tab-name <name>]]
                      [--focus] [-- <agent args>]
                                          start an Agent in a new pane, or with --tab
                                          in a new Tab of its own
  abundio agent prompt <agent> <text> [--wait] [--timeout <ms>]
                                          send a prompt; --wait returns when it settles
  abundio agent wait <agent> [--until settled|ready|waiting|error] [--timeout <ms>]
  abundio agent send-keys <agent|pane> <key>...
                                          enter, esc, tab, ctrl+c, up, …
  abundio agent rename <agent> [<handle>] set or clear an Agent handle
";
    const WORKSPACE: &str = "\
Workspaces:
  abundio workspace list                  every Workspace of your Profile: name, folder,
                                          branch, whether it is open, and its Agents
";
    const TAB: &str = "\
Tabs:
  abundio tab new [--name <name>] [--focus]
                                          a shell in a new Tab
  abundio tab rename <name> [--tab <pane|agent>]
                                          rename your own Tab, or the Tab holding that
                                          pane: only yours or ones you opened, never
                                          one the user named
";
    const HEAD: &str = "\
abundio: control the panes and Agents of your Profile's Workspaces.

<pane> is a Pane number (p1, p2, …). <agent> is an Agent handle or a Pane number.
A handle is matched ignoring case, a space and a dash alike; quote one with spaces
(\"Agent Two\" and agent-two are the same Agent).
Every command prints one JSON object. --timeout is in milliseconds; 0 means no limit;
the default for waits is 30 minutes. A new pane leaves the user's keyboard focus
where it is; pass --focus to move it there, but only when the user asks for that.
A split in a crowded Tab still happens, and its reply carries a \"hint\": next time,
open the Agent with --tab.
Every command acts on your own Workspace; add --workspace <name> to act on another
of your Profile (see `abundio workspace list`). A closed one is opened for the call,
which starts its Agents: do that only when the user asks. A new pane there always
gets a Tab of its own.

";
    match group {
        Some("pane") => PANE.to_string(),
        Some("agent") => AGENT.to_string(),
        Some("tab") => TAB.to_string(),
        Some("workspace") => WORKSPACE.to_string(),
        _ => format!("{HEAD}{PANE}\n{AGENT}\n{TAB}\n{WORKSPACE}"),
    }
}

/// The NUL-separated argv the CLI sends (`printf '%s\0' "$@"`).
pub fn split_nul_args(body: &[u8]) -> Result<Vec<String>, String> {
    if body.is_empty() {
        return Ok(Vec::new());
    }
    let trimmed = body.strip_suffix(&[0]).unwrap_or(body);
    trimmed
        .split(|b| *b == 0)
        .map(|part| {
            String::from_utf8(part.to_vec()).map_err(|_| "arguments are not UTF-8".to_string())
        })
        .collect()
}

// ── The setting ──

/// App-global `settings` key for "Let agents control panes". Absent means on.
pub const SETTING_KEY: &str = "agent_control_enabled";

pub fn enabled(store: &crate::workspace_store::WorkspaceStore) -> bool {
    !matches!(store.get_setting(SETTING_KEY), Ok(Some(v)) if v == "0")
}

// ── Answers ──

/// An HTTP answer for the CLI: status 200 prints the body to stdout and exits
/// 0; 400 is a usage error (exit 2); anything else prints to stderr and exits
/// 1.
pub struct Answer {
    pub status: u16,
    pub body: String,
}

pub fn error_answer(status: u16, code: &str, message: &str) -> Answer {
    Answer {
        status,
        body: json!({ "error": { "code": code, "message": message } }).to_string(),
    }
}

/// Turn a Window's reply into an answer. A reply is either `{ "result": … }`
/// or `{ "error": { "code", "message" } }`.
fn answer_from_reply(reply: Value) -> Answer {
    if let Some(err) = reply.get("error") {
        return Answer {
            status: 409,
            body: json!({ "error": err }).to_string(),
        };
    }
    Answer {
        status: 200,
        body: reply.get("result").cloned().unwrap_or(Value::Null).to_string(),
    }
}

/// Whether this request changes something, so a retry after a dropped
/// connection could do it twice. Prompts are the exception the CLI handles:
/// a retried `prompt --wait` becomes a plain wait.
fn is_mutating(request: &Request) -> bool {
    !matches!(
        request,
        Request::PaneList
            | Request::WorkspaceList
            | Request::PaneCurrent
            | Request::PaneRead { .. }
            | Request::AgentList
            | Request::AgentWait { .. }
    )
}

fn op_name(request: &Request) -> String {
    serde_json::to_value(request)
        .ok()
        .and_then(|v| v.get("op").and_then(|o| o.as_str()).map(str::to_string))
        .unwrap_or_default()
}

// ── Reach across the Profile (ADR-0055) ──

/// Take `--workspace <name>` out of `argv` (anywhere before `--`), leaving
/// the command line every parser already knows.
pub fn split_workspace(argv: &[String]) -> Result<(Option<String>, Vec<String>), String> {
    let mut rest = Vec::with_capacity(argv.len());
    let mut workspace = None;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--" {
            rest.extend(argv[i..].iter().cloned());
            break;
        }
        if a == "--workspace" {
            let name = argv
                .get(i + 1)
                .filter(|n| !n.trim().is_empty())
                .ok_or("--workspace needs a Workspace name; run `abundio workspace list`")?;
            if workspace.is_some() {
                return Err("--workspace given twice".into());
            }
            workspace = Some(name.trim().to_string());
            i += 2;
            continue;
        }
        rest.push(a.clone());
        i += 1;
    }
    Ok((workspace, rest))
}

/// One Workspace of a Profile, as resolution needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub folder: String,
}

/// The Workspace `name` names among `rows` (one Profile's), matched exactly
/// but ignoring case. `Err((code, message))` when none or several do.
pub fn pick_workspace<'a>(
    rows: &'a [WorkspaceRow],
    name: &str,
) -> Result<&'a WorkspaceRow, (&'static str, String)> {
    let wanted = name.to_lowercase();
    let hits: Vec<&WorkspaceRow> = rows.iter().filter(|r| r.name.to_lowercase() == wanted).collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] => {
            let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
            Err((
                "not_found",
                format!(
                    "no Workspace called {name:?} in this Profile; it has: {}",
                    names.join(", ")
                ),
            ))
        }
        many => {
            let folders: Vec<&str> = many.iter().map(|r| r.folder.as_str()).collect();
            Err((
                "ambiguous_workspace",
                format!(
                    "{} Workspaces are called {name:?} (in {}); ask the user to rename one",
                    many.len(),
                    folders.join(", ")
                ),
            ))
        }
    }
}

/// Where a call naming `workspace` goes, for `caller`.
fn resolve_scope(app: &AppHandle, caller: &Caller, workspace: Option<&str>) -> Result<Scope, Answer> {
    let Some(name) = workspace else {
        return Ok(Scope::home(caller));
    };
    let store = app
        .try_state::<crate::workspace_store::WorkspaceStore>()
        .ok_or_else(|| error_answer(503, "unavailable", "Agent control is not ready"))?;
    let profile = store
        .profile_of(&caller.workspace_id)
        .map_err(|e| error_answer(500, "internal", &e.to_string()))?
        .ok_or_else(|| error_answer(409, "not_found", "your Workspace no longer exists"))?;
    let rows: Vec<WorkspaceRow> = store
        .list(&profile)
        .map_err(|e| error_answer(500, "internal", &e.to_string()))?
        .into_iter()
        .map(|w| WorkspaceRow {
            id: w.workspace.id,
            name: w.workspace.name,
            folder: w.workspace.root_folder,
        })
        .collect();
    let target = pick_workspace(&rows, name).map_err(|(code, msg)| error_answer(409, code, &msg))?;
    if target.id == caller.workspace_id {
        return Ok(Scope::home(caller));
    }
    // Nothing new starts in a Missing folder (ADR-0053).
    if !std::path::Path::new(&target.folder).is_dir() {
        return Err(error_answer(
            409,
            "folder_missing",
            &format!("the Workspace {:?} has lost its folder ({})", target.name, target.folder),
        ));
    }
    let live = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().window_for_workspace(&target.id));
    Ok(match live {
        Some(window_label) => Scope {
            workspace_id: target.id.clone(),
            open: false,
            window_label,
        },
        // Not Opened anywhere: the caller's Window opens it in the background.
        None => Scope {
            workspace_id: target.id.clone(),
            open: true,
            window_label: caller.window_label.clone(),
        },
    })
}

/// Terminal panes of a layout in tree order, with their Agent and handle.
fn terminal_panes(tree: &Value, out: &mut Vec<(String, Option<String>, Option<String>)>) {
    match tree.get("type").and_then(|t| t.as_str()) {
        Some("terminal") => {
            if let Some(id) = tree.get("id").and_then(|v| v.as_str()) {
                let s = |k: &str| tree.get(k).and_then(|v| v.as_str()).map(str::to_string);
                out.push((id.to_string(), s("agentId"), s("agentHandle")));
            }
        }
        Some("split") => {
            for side in ["first", "second"] {
                if let Some(child) = tree.get(side) {
                    terminal_panes(child, out);
                }
            }
        }
        _ => {}
    }
}

/// `workspace list`: every Workspace of the caller's Profile, from the
/// database, with `open` from the live PTYs. Running status is the Windows'
/// to tell (`agent list --workspace <name>`).
pub fn workspace_listing(
    store: &crate::workspace_store::WorkspaceStore,
    caller: &Caller,
    is_open: &dyn Fn(&str) -> bool,
) -> Result<Value, crate::error::AbundioError> {
    let Some(profile) = store.profile_of(&caller.workspace_id)? else {
        return Ok(json!({ "workspaces": [] }));
    };
    let mut out = Vec::new();
    for w in store.list(&profile)? {
        let mut panes = Vec::new();
        for tab in &w.tabs {
            if let Ok(tree) = serde_json::from_str::<Value>(&tab.layout_json) {
                terminal_panes(&tree, &mut panes);
            }
        }
        let ids: Vec<String> = panes.iter().map(|(id, _, _)| id.clone()).collect();
        let numbers: HashMap<String, u32> =
            store.pane_numbers(&w.workspace.id, &ids)?.into_iter().collect();
        let agents: Vec<Value> = panes
            .iter()
            .filter(|(_, agent, _)| agent.is_some())
            .map(|(id, agent, handle)| {
                json!({
                    "pane": numbers.get(id).map(|n| format!("p{n}")),
                    "handle": handle,
                    "agent": agent,
                })
            })
            .collect();
        out.push(json!({
            "name": w.workspace.name,
            "folder": w.workspace.root_folder,
            "branch": w.workspace.last_branch,
            "open": is_open(&w.workspace.id),
            "self": w.workspace.id == caller.workspace_id,
            "agents": agents,
        }));
    }
    Ok(json!({ "workspaces": out }))
}

fn workspace_list_answer(app: &AppHandle, caller: &Caller) -> Answer {
    let Some(store) = app.try_state::<crate::workspace_store::WorkspaceStore>() else {
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    let tokens = app.try_state::<crate::pty_manager::PtyManager>();
    let is_open = |ws: &str| {
        tokens
            .as_ref()
            .and_then(|m| m.control_tokens().window_for_workspace(ws))
            .is_some()
    };
    match workspace_listing(&store, caller, &is_open) {
        Ok(v) => Answer {
            status: 200,
            body: v.to_string(),
        },
        Err(e) => error_answer(500, "internal", &e.to_string()),
    }
}

/// The Workspace a call acts on, and the Window that carries it out
/// (ADR-0055). Its own Workspace unless the caller named another with
/// `--workspace`. `open`: the Workspace is not Opened anywhere, so the Window
/// (the caller's) opens it in the background first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub workspace_id: String,
    pub open: bool,
    #[serde(skip)]
    pub window_label: String,
}

impl Scope {
    /// The caller's own Workspace, in its own Window.
    pub fn home(caller: &Caller) -> Self {
        Scope {
            workspace_id: caller.workspace_id.clone(),
            open: false,
            window_label: caller.window_label.clone(),
        }
    }
}

/// The request event a Window hears.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ControlEvent<'a> {
    id: &'a str,
    caller: &'a Caller,
    target: &'a Scope,
    request: &'a Value,
}

/// Send `request` to the target's Window and wait up to `limit` for its reply
/// (`None`: no limit). On a timeout the Window is told to drop the request.
fn ask_window(
    app: &AppHandle,
    caller: &Caller,
    scope: &Scope,
    request: &Value,
    limit: Option<Duration>,
) -> Result<Value, Answer> {
    if app.get_webview_window(&scope.window_label).is_none() {
        return Err(error_answer(
            503,
            "window_gone",
            "the Window that owns this Workspace is closed",
        ));
    }
    let pending = app
        .try_state::<PendingRequests>()
        .ok_or_else(|| error_answer(503, "unavailable", "Agent control is not ready"))?;
    let (id, rx) = pending.register();
    let event = ControlEvent {
        id: &id,
        caller,
        target: scope,
        request,
    };
    if app
        .emit_to(&scope.window_label, "agent-control-request", event)
        .is_err()
    {
        pending.forget(&id);
        return Err(error_answer(503, "window_gone", "could not reach the Window"));
    }
    let reply = match limit {
        Some(d) => rx.recv_timeout(d).ok(),
        None => rx.recv().ok(),
    };
    match reply {
        Some(v) => Ok(v),
        None => {
            pending.forget(&id);
            let _ = app.emit_to(
                &scope.window_label,
                "agent-control-cancel",
                json!({ "id": id }),
            );
            Err(error_answer(
                504,
                "timeout",
                "no answer in time; the action may still have happened, so check before retrying",
            ))
        }
    }
}

/// Carry out one parsed request for `caller`. `retry` is set when the CLI is
/// sending the same command again after the connection dropped mid-call.
pub fn handle(
    app: &AppHandle,
    caller: &Caller,
    scope: &Scope,
    request: Request,
    retry: bool,
) -> Answer {
    if let Request::WorkspaceList = request {
        return workspace_list_answer(app, caller);
    }
    let request = match (retry, request) {
        // The prompt reached the Window the first time; only wait again.
        (
            true,
            Request::AgentPrompt {
                target,
                wait: true,
                timeout_ms,
                ..
            },
        ) => Request::AgentWait {
            target,
            until: Until::Settled,
            timeout_ms,
        },
        (true, r) if is_mutating(&r) => {
            return error_answer(
                409,
                "connection_lost",
                "the connection dropped during this call, so it may already have happened; check before running it again",
            )
        }
        (_, r) => r,
    };

    let wait = match &request {
        Request::AgentWait {
            target, timeout_ms, ..
        } => Some((target.clone(), *timeout_ms)),
        Request::AgentPrompt {
            target,
            wait: true,
            timeout_ms,
            ..
        } => Some((target.clone(), *timeout_ms)),
        _ => None,
    };
    let value = match serde_json::to_value(&request) {
        Ok(v) => v,
        Err(e) => return error_answer(500, "internal", &e.to_string()),
    };

    let Some((target, timeout_ms)) = wait else {
        return match ask_window(app, caller, scope, &value, Some(PLAIN_REPLY_TIMEOUT)) {
            Ok(reply) => answer_from_reply(reply),
            Err(answer) => answer,
        };
    };

    // A wait: learn the target's pane, refuse a loop, then wait.
    let resolve = json!({ "op": "resolve", "target": target });
    let target_pane = match ask_window(app, caller, scope, &resolve, Some(PLAIN_REPLY_TIMEOUT)) {
        Ok(reply) => match reply
            .get("result")
            .and_then(|r| r.get("paneId"))
            .and_then(|p| p.as_str())
        {
            Some(p) => p.to_string(),
            None => return answer_from_reply(reply),
        },
        Err(answer) => return answer,
    };
    let Some(graph) = app.try_state::<WaitGraph>() else {
        return error_answer(503, "unavailable", "Agent control is not ready");
    };
    let wait_id = uuid::Uuid::new_v4().to_string();
    if !graph.try_add(&wait_id, &caller.pane_id, &target_pane) {
        return error_answer(
            409,
            "cycle",
            "that Agent is already waiting on you (directly or through others), so this wait would never end",
        );
    }
    let answer = match ask_window(app, caller, scope, &value, timeout_ms.map(Duration::from_millis)) {
        Ok(reply) => answer_from_reply(reply),
        Err(answer) => answer,
    };
    graph.remove(&wait_id);
    answer
}

/// Serve one `/control` request. Runs on its own thread: the hook server's
/// accept loop is sequential, and a wait may last 30 minutes.
pub fn serve(app: AppHandle, mut request: tiny_http::Request) {
    const MAX_BODY: u64 = 1024 * 1024;
    let token = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Abundio-Agent-Token"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let retry = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Abundio-Retry"));
    let mut body = Vec::new();
    let _ = request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut body);

    let (answer, log) = serve_inner(&app, &token, &body, retry);
    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
    // Never the prompt or the text read: only who did what, and how it went.
    eprintln!("[{ts}] [abundio:control] {log} status={}", answer.status);

    let content_type = if answer.status == 200 && !answer.body.starts_with('{') {
        "text/plain; charset=utf-8"
    } else {
        "application/json"
    };
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .expect("static header");
    let _ = request.respond(
        tiny_http::Response::from_string(answer.body)
            .with_status_code(answer.status)
            .with_header(header),
    );
}

fn serve_inner(app: &AppHandle, token: &str, body: &[u8], retry: bool) -> (Answer, String) {
    let caller = app
        .try_state::<crate::pty_manager::PtyManager>()
        .and_then(|mgr| mgr.control_tokens().lookup(token));
    let Some(caller) = caller else {
        return (
            error_answer(
                403,
                "unauthorized",
                "not running inside an Abundio pane (no valid ABUNDIO_AGENT_TOKEN)",
            ),
            "rejected: bad or missing token".into(),
        );
    };
    let who = format!("caller={} ws={}", caller.pane_id, caller.workspace_id);
    if body.len() as u64 > 1024 * 1024 {
        return (
            error_answer(413, "too_large", "the arguments are over 1 MB"),
            who,
        );
    }
    let argv = match split_nul_args(body) {
        Ok(a) => a,
        Err(e) => return (error_answer(400, "usage", &e), who),
    };
    let (workspace, argv) = match split_workspace(&argv) {
        Ok(split) => split,
        Err(e) => return (error_answer(400, "usage", &e), format!("{who} op=usage-error")),
    };
    let request = match parse_args(&argv) {
        Ok(Parsed::Help(text)) => {
            return (
                Answer {
                    status: 200,
                    body: text,
                },
                format!("{who} op=help"),
            )
        }
        Ok(Parsed::Request(r)) => r,
        Err(e) => return (error_answer(400, "usage", &e), format!("{who} op=usage-error")),
    };
    let op = op_name(&request);
    let on = app
        .try_state::<crate::workspace_store::WorkspaceStore>()
        .map(|s| enabled(&s))
        .unwrap_or(false);
    if !on {
        return (
            error_answer(
                403,
                "disabled",
                "Agent control is turned off (Settings ▸ Agents ▸ Let agents control panes)",
            ),
            format!("{who} op={op}"),
        );
    }
    let scope = match resolve_scope(app, &caller, workspace.as_deref()) {
        Ok(s) => s,
        Err(answer) => return (answer, format!("{who} op={op} target=?")),
    };
    let target = if scope.workspace_id == caller.workspace_id {
        String::new()
    } else {
        format!(" target={}{}", scope.workspace_id, if scope.open { " opening" } else { "" })
    };
    let answer = handle(app, &caller, &scope, request, retry);
    (
        answer,
        format!("{who} op={op}{target}{}", if retry { " retry" } else { "" }),
    )
}

// ── Commands ──

/// A Window's answer to an `agent-control-request`.
#[tauri::command]
pub fn agent_control_reply(
    pending: tauri::State<'_, PendingRequests>,
    id: String,
    reply: Value,
) -> Result<bool, crate::error::AbundioError> {
    Ok(pending.complete(&id, reply))
}

#[tauri::command]
pub fn agent_control_enabled(
    store: tauri::State<'_, crate::workspace_store::WorkspaceStore>,
) -> Result<bool, crate::error::AbundioError> {
    Ok(enabled(&store))
}

#[tauri::command]
pub fn agent_control_set_enabled(
    store: tauri::State<'_, crate::workspace_store::WorkspaceStore>,
    enabled: bool,
) -> Result<(), crate::error::AbundioError> {
    store.set_setting(SETTING_KEY, if enabled { "1" } else { "0" })
}

/// The Pane numbers of `pane_ids`, claiming new ones in the order given.
#[tauri::command]
pub fn agent_control_pane_numbers(
    store: tauri::State<'_, crate::workspace_store::WorkspaceStore>,
    workspace_id: String,
    pane_ids: Vec<String>,
) -> Result<Vec<(String, u32)>, crate::error::AbundioError> {
    store.pane_numbers(&workspace_id, &pane_ids)
}

#[tauri::command]
pub fn agent_control_pane_for_number(
    store: tauri::State<'_, crate::workspace_store::WorkspaceStore>,
    workspace_id: String,
    number: u32,
) -> Result<Option<String>, crate::error::AbundioError> {
    store.pane_for_number(&workspace_id, number)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn req(s: &[&str]) -> Request {
        match parse_args(&argv(s)) {
            Ok(Parsed::Request(r)) => r,
            other => panic!("expected a request for {s:?}, got {other:?}"),
        }
    }

    fn usage_err(s: &[&str]) -> String {
        match parse_args(&argv(s)) {
            Err(e) => e,
            other => panic!("expected a usage error for {s:?}, got {other:?}"),
        }
    }

    fn caller(pty: &str) -> Caller {
        Caller {
            pty_id: pty.into(),
            pane_id: format!("pane-{pty}"),
            workspace_id: "ws".into(),
            window_label: "main".into(),
        }
    }

    // ── Tokens ──

    #[test]
    fn a_token_names_its_caller_until_revoked() {
        let tokens = ControlTokens::default();
        let t = tokens.issue(caller("a"));
        assert_eq!(t.len(), 64);
        assert_eq!(tokens.lookup(&t), Some(caller("a")));
        tokens.revoke_pty("a");
        assert_eq!(tokens.lookup(&t), None);
    }

    #[test]
    fn tokens_differ_per_pty() {
        let tokens = ControlTokens::default();
        let a = tokens.issue(caller("a"));
        let b = tokens.issue(caller("b"));
        assert_ne!(a, b);
        assert_eq!(tokens.lookup(&b).unwrap().pty_id, "b");
    }

    #[test]
    fn reissuing_for_a_pty_retires_its_old_token() {
        let tokens = ControlTokens::default();
        let old = tokens.issue(caller("a"));
        let new = tokens.issue(caller("a"));
        assert_eq!(tokens.lookup(&old), None);
        assert!(tokens.lookup(&new).is_some());
    }

    #[test]
    fn revoking_an_old_token_leaves_a_newer_one_of_the_same_pty() {
        // A respawn reuses the pty id: the old PTY thread exiting late must
        // not revoke the new PTY's token.
        let tokens = ControlTokens::default();
        let old = tokens.issue(caller("a"));
        let new = tokens.issue(caller("a"));
        tokens.revoke_token(&old);
        assert!(tokens.lookup(&new).is_some());
        tokens.revoke_token(&new);
        assert_eq!(tokens.lookup(&new), None);
    }

    #[test]
    fn an_unknown_token_names_nobody() {
        let tokens = ControlTokens::default();
        tokens.issue(caller("a"));
        assert_eq!(tokens.lookup(""), None);
        assert_eq!(tokens.lookup("nope"), None);
    }

    // ── Pending requests ──

    #[test]
    fn a_reply_reaches_its_waiting_request_once() {
        let pending = PendingRequests::default();
        let (id, rx) = pending.register();
        assert!(pending.complete(&id, json!({ "result": 1 })));
        assert_eq!(rx.recv().unwrap(), json!({ "result": 1 }));
        assert!(!pending.complete(&id, json!({ "result": 2 })));
    }

    #[test]
    fn a_reply_after_forgetting_is_dropped() {
        let pending = PendingRequests::default();
        let (id, _rx) = pending.register();
        pending.forget(&id);
        assert!(!pending.complete(&id, json!({})));
    }

    // ── Wait graph ──

    #[test]
    fn waiting_on_yourself_is_a_loop() {
        let g = WaitGraph::default();
        assert!(!g.try_add("w1", "a", "a"));
    }

    #[test]
    fn a_direct_loop_is_refused() {
        let g = WaitGraph::default();
        assert!(g.try_add("w1", "a", "b"));
        assert!(!g.try_add("w2", "b", "a"));
    }

    #[test]
    fn a_three_pane_loop_is_refused() {
        let g = WaitGraph::default();
        assert!(g.try_add("w1", "a", "b"));
        assert!(g.try_add("w2", "b", "c"));
        assert!(!g.try_add("w3", "c", "a"));
        // Not a loop: c may wait on someone else.
        assert!(g.try_add("w4", "c", "d"));
    }

    #[test]
    fn a_finished_wait_no_longer_counts() {
        let g = WaitGraph::default();
        assert!(g.try_add("w1", "a", "b"));
        g.remove("w1");
        assert!(g.try_add("w2", "b", "a"));
    }

    #[test]
    fn two_panes_may_wait_on_the_same_one() {
        let g = WaitGraph::default();
        assert!(g.try_add("w1", "a", "c"));
        assert!(g.try_add("w2", "b", "c"));
        assert!(g.try_add("w3", "a", "c"));
    }

    // ── Handles and targets ──

    /// The same table `lib/agentHandle.ts` is tested against.
    #[derive(serde::Deserialize)]
    struct HandleCases {
        valid: Vec<(String, String, String)>,
        invalid: Vec<String>,
    }

    #[test]
    fn handle_grammar_matches_the_shared_table() {
        let cases: HandleCases = serde_json::from_str(include_str!(
            "../../src/lib/__tests__/fixtures/handleGrammar.json"
        ))
        .unwrap();
        for (input, normalized, key) in &cases.valid {
            assert_eq!(normalize_handle(input).as_deref(), Some(normalized.as_str()), "{input:?}");
            assert_eq!(handle_key(input), *key, "key of {input:?}");
            assert!(valid_handle(normalized), "{normalized:?} is stored form");
        }
        for bad in &cases.invalid {
            assert_eq!(normalize_handle(bad), None, "{bad:?} should be invalid");
        }
    }

    #[test]
    fn targets_are_pane_numbers_or_handles() {
        assert_eq!(parse_target("p3"), Ok(Target::Pane(3)));
        assert_eq!(parse_target("P3"), Ok(Target::Pane(3)));
        assert_eq!(parse_target("reviewer"), Ok(Target::Handle("reviewer".into())));
        // A quoted name arrives as one argument, spaces and all.
        assert_eq!(parse_target("  Agent   Two "), Ok(Target::Handle("Agent Two".into())));
        assert!(parse_target("p0").is_err());
        assert!(parse_target("").is_err());
    }

    // ── Parsing ──

    #[test]
    fn no_arguments_or_help_prints_help() {
        assert!(matches!(parse_args(&[]), Ok(Parsed::Help(t)) if t.contains("abundio pane list")));
        assert!(matches!(parse_args(&argv(&["--help"])), Ok(Parsed::Help(_))));
        assert!(matches!(parse_args(&argv(&["help", "agent"])), Ok(Parsed::Help(t)) if t.starts_with("Agents")));
        assert!(matches!(parse_args(&argv(&["pane"])), Ok(Parsed::Help(t)) if t.starts_with("Panes")));
    }

    #[test]
    fn pane_commands() {
        assert_eq!(req(&["pane", "list"]), Request::PaneList);
        assert_eq!(req(&["pane", "current"]), Request::PaneCurrent);
        assert_eq!(
            req(&["pane", "read", "p2", "--lines", "120", "--visible"]),
            Request::PaneRead { target: Target::Pane(2), lines: Some(120), visible: true }
        );
        assert_eq!(
            req(&["pane", "split", "--direction", "down"]),
            Request::PaneSplit { direction: Some(Direction::Down), focus: false }
        );
        assert_eq!(
            req(&["pane", "run", "p4", "just test"]),
            Request::PaneRun { target: Target::Pane(4), command: "just test".into() }
        );
        assert_eq!(req(&["pane", "close", "p4"]), Request::PaneClose { target: Target::Pane(4) });
    }

    #[test]
    fn pane_usage_errors() {
        assert!(usage_err(&["pane", "read"]).starts_with("usage:"));
        assert!(usage_err(&["pane", "read", "p1", "--lines", "0"]).contains("--lines"));
        assert!(usage_err(&["pane", "read", "p1", "--lines"]).contains("needs a value"));
        assert!(usage_err(&["pane", "split", "--direction", "left"]).contains("right or down"));
        assert!(usage_err(&["pane", "run", "p1", "a\nb"]).contains("one line"));
        assert!(usage_err(&["pane", "run", "p1", "  "]).contains("empty"));
        assert!(usage_err(&["pane", "list", "--bogus"]).contains("unknown option"));
        assert!(usage_err(&["pane", "frob"]).contains("unknown command"));
        assert!(usage_err(&["nope"]).contains("unknown command"));
    }

    #[test]
    fn tab_commands() {
        assert_eq!(
            req(&["tab", "new"]),
            Request::TabNew { name: None, focus: false }
        );
        assert_eq!(
            req(&["tab", "new", "--name", "Logs", "--focus"]),
            Request::TabNew { name: Some("Logs".into()), focus: true }
        );
        assert_eq!(
            req(&["tab", "rename", "Fix the build"]),
            Request::TabRename { name: "Fix the build".into(), target: None }
        );
        assert_eq!(
            req(&["tab", "rename", "Review", "--tab", "p7"]),
            Request::TabRename { name: "Review".into(), target: Some(Target::Pane(7)) }
        );
        assert_eq!(
            req(&["tab", "rename", "Review", "--tab", "reviewer"]),
            Request::TabRename {
                name: "Review".into(),
                target: Some(Target::Handle("reviewer".into()))
            }
        );
        // Tab names: one line, no control characters, 1–64 characters.
        assert!(usage_err(&["tab", "rename", "  "]).contains("empty"));
        assert!(usage_err(&["tab", "rename", "a\nb"]).contains("one line"));
        assert!(usage_err(&["tab", "new", "--name", "a\u{1b}[2J"]).contains("one line"));
        assert!(usage_err(&["tab", "rename", &"x".repeat(65)]).contains("at most 64"));
        assert!(matches!(
            req(&["tab", "rename", &"é".repeat(64)]),
            Request::TabRename { .. }
        ));
        assert!(usage_err(&["tab", "rename"]).contains("abundio tab rename"));
        assert!(usage_err(&["tab", "close", "p2"]).contains("unknown command `tab close`"));
        // Both change something, so a dropped connection is not retried.
        assert!(is_mutating(&req(&["tab", "new"])));
        assert!(is_mutating(&req(&["tab", "rename", "x"])));
        assert_eq!(op_name(&req(&["tab", "rename", "x"])), "tab.rename");
    }

    // ── Reach across the Profile (ADR-0055) ──

    #[test]
    fn workspace_option_is_taken_out_anywhere_before_the_passthrough() {
        let (ws, rest) = split_workspace(&argv(&["agent", "prompt", "reviewer", "hi", "--workspace", " api "])).unwrap();
        assert_eq!(ws.as_deref(), Some("api"));
        assert_eq!(rest, argv(&["agent", "prompt", "reviewer", "hi"]));
        let (ws, rest) = split_workspace(&argv(&["--workspace", "web", "agent", "list"])).unwrap();
        assert_eq!(ws.as_deref(), Some("web"));
        assert_eq!(rest, argv(&["agent", "list"]));
        // After `--` it belongs to the Agent's own arguments.
        let (ws, rest) =
            split_workspace(&argv(&["agent", "start", "--kind", "codex", "--", "--workspace", "x"])).unwrap();
        assert_eq!(ws, None);
        assert_eq!(rest.last().map(String::as_str), Some("x"));
        assert!(split_workspace(&argv(&["agent", "list", "--workspace"])).is_err());
        assert!(split_workspace(&argv(&["agent", "list", "--workspace", " "])).is_err());
        assert!(split_workspace(&argv(&["--workspace", "a", "--workspace", "b", "pane", "list"]))
            .unwrap_err()
            .contains("twice"));
    }

    fn rows() -> Vec<WorkspaceRow> {
        [("1", "api", "/src/api"), ("2", "Web", "/src/web"), ("3", "dup", "/a/dup"), ("4", "Dup", "/b/dup")]
            .map(|(id, name, folder)| WorkspaceRow { id: id.into(), name: name.into(), folder: folder.into() })
            .to_vec()
    }

    #[test]
    fn workspaces_are_picked_by_name_ignoring_case() {
        let rows = rows();
        assert_eq!(pick_workspace(&rows, "API").unwrap().id, "1");
        assert_eq!(pick_workspace(&rows, "web").unwrap().id, "2");
        let (code, msg) = pick_workspace(&rows, "dup").unwrap_err();
        assert_eq!(code, "ambiguous_workspace");
        assert!(msg.contains("/a/dup") && msg.contains("/b/dup"));
        let (code, msg) = pick_workspace(&rows, "mobile").unwrap_err();
        assert_eq!(code, "not_found");
        assert!(msg.contains("api, Web"));
        // Exact names only: no prefix matching.
        assert!(pick_workspace(&rows, "ap").is_err());
    }

    #[test]
    fn a_workspace_window_is_read_off_its_live_ptys() {
        let tokens = ControlTokens::default();
        assert_eq!(tokens.window_for_workspace("ws"), None);
        tokens.issue(Caller { window_label: "window-2".into(), ..caller("a") });
        assert_eq!(tokens.window_for_workspace("ws").as_deref(), Some("window-2"));
        assert_eq!(tokens.window_for_workspace("other"), None);
    }

    #[test]
    fn workspace_list_parses_and_is_read_only() {
        assert_eq!(req(&["workspace", "list"]), Request::WorkspaceList);
        assert!(!is_mutating(&Request::WorkspaceList));
        assert!(usage_err(&["workspace", "list", "extra"]).contains("usage"));
        assert!(usage_err(&["workspace", "open", "x"]).contains("unknown command `workspace open`"));
        assert!(matches!(parse_args(&argv(&["workspace"])), Ok(Parsed::Help(t)) if t.starts_with("Workspaces")));
        assert!(matches!(parse_args(&[]), Ok(Parsed::Help(t)) if t.contains("--workspace <name>")));
    }

    #[test]
    fn the_request_event_carries_its_target() {
        let c = caller("a");
        let scope = Scope { workspace_id: "other".into(), open: true, window_label: "main".into() };
        let v = serde_json::to_value(ControlEvent { id: "1", caller: &c, target: &scope, request: &json!({}) }).unwrap();
        assert_eq!(v["target"], json!({ "workspaceId": "other", "open": true }));
        assert_eq!(Scope::home(&c), Scope { workspace_id: "ws".into(), open: false, window_label: "main".into() });
    }

    #[test]
    fn workspace_listing_covers_the_profile_with_its_agents() {
        use crate::workspace_store::{TabUpdate, WorkspaceStore};
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let store = WorkspaceStore::new(conn);
        const PID: &str = "00000000-0000-0000-0000-000000000001";
        let api = store.create("api", "/src/api", PID).unwrap();
        let web = store.create("web", "/src/web", PID).unwrap();
        let layout = json!({
            "type": "split", "id": "s", "direction": "vertical", "ratio": 0.5,
            "first": { "type": "terminal", "id": "sh", "ptyId": "" },
            "second": { "type": "terminal", "id": "ag", "ptyId": "", "agentId": "claude", "agentHandle": "Agent One" }
        });
        store
            .update_tab(&web.tabs[0].id, TabUpdate { layout_json: Some(layout.to_string()), ..Default::default() })
            .unwrap();
        let me = Caller { workspace_id: api.workspace.id.clone(), ..caller("a") };
        let web_id = web.workspace.id.clone();
        let v = workspace_listing(&store, &me, &|ws| ws == web_id).unwrap();
        let list = v["workspaces"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["name"], "api");
        assert_eq!(list[0]["self"], true);
        assert_eq!(list[0]["open"], false);
        assert_eq!(list[1]["open"], true);
        // Numbered in tree order, like the Window does: the shell is p1.
        assert_eq!(list[1]["agents"], json!([{ "pane": "p2", "handle": "Agent One", "agent": "claude" }]));
    }

    #[test]
    fn tab_help() {
        let Ok(Parsed::Help(text)) = parse_args(&["tab".to_string()]) else {
            panic!("tab alone is help");
        };
        assert!(text.contains("abundio tab rename"));
        let Ok(Parsed::Help(all)) = parse_args(&[]) else { panic!() };
        assert!(all.contains("Tabs:") && all.contains("--tab-name"));
    }

    #[test]
    fn agent_start() {
        assert_eq!(
            req(&["agent", "start", "--kind", "codex", "--handle", "reviewer", "--prompt", "hi", "--", "--model", "x"]),
            Request::AgentStart {
                handle: Some("reviewer".into()),
                kind: "codex".into(),
                prompt: Some("hi".into()),
                direction: None,
                args: vec!["--model".into(), "x".into()],
                focus: false,
                tab: false,
                tab_name: None,
            }
        );
        assert!(matches!(
            req(&["agent", "start", "--kind", "codex", "--focus"]),
            Request::AgentStart { focus: true, .. }
        ));
        assert!(matches!(
            req(&["agent", "start", "--kind", "codex", "--tab", "--tab-name", "  Review  "]),
            Request::AgentStart { tab: true, tab_name: Some(ref n), .. } if n == "Review"
        ));
        assert!(matches!(
            req(&["agent", "start", "--kind", "codex", "--tab"]),
            Request::AgentStart { tab: true, tab_name: None, .. }
        ));
        assert!(usage_err(&["agent", "start", "--kind", "codex", "--tab-name", "x"]).contains("needs --tab"));
        assert!(usage_err(&["agent", "start", "--kind", "codex", "--tab", "--direction", "down"])
            .contains("--direction is for a split"));
        assert!(usage_err(&["agent", "start", "--kind", "codex", "--tab", "--tab-name", " "]).contains("empty"));
        assert!(usage_err(&["agent", "start"]).contains("--kind is required"));
        assert!(usage_err(&["agent", "start", "--kind", "codex", "--handle", "p1"]).contains("not a valid Agent handle"));
        assert!(usage_err(&["agent", "start", "--kind", "codex", "--", "a\u{1b}b"]).contains("control characters"));
    }

    #[test]
    fn agent_prompt_defaults_and_timeouts() {
        assert_eq!(
            req(&["agent", "prompt", "reviewer", "Review it"]),
            Request::AgentPrompt { target: Target::Handle("reviewer".into()), text: "Review it".into(), wait: false, timeout_ms: None }
        );
        assert_eq!(
            req(&["agent", "prompt", "p2", "go", "--wait"]),
            Request::AgentPrompt { target: Target::Pane(2), text: "go".into(), wait: true, timeout_ms: Some(DEFAULT_WAIT_TIMEOUT_MS) }
        );
        assert_eq!(
            req(&["agent", "prompt", "p2", "go", "--wait", "--timeout", "0"]),
            Request::AgentPrompt { target: Target::Pane(2), text: "go".into(), wait: true, timeout_ms: None }
        );
        assert!(usage_err(&["agent", "prompt", "p2", "go", "--timeout", "5"]).contains("needs --wait"));
        assert!(usage_err(&["agent", "prompt", "p2", ""]).contains("empty"));
        assert!(usage_err(&["agent", "prompt", "p2", "go", "--wait", "--timeout", "soon"]).contains("milliseconds"));
    }

    #[test]
    fn agent_wait_send_keys_rename() {
        assert_eq!(
            req(&["agent", "wait", "reviewer", "--until", "waiting", "--timeout", "1000"]),
            Request::AgentWait { target: Target::Handle("reviewer".into()), until: Until::Waiting, timeout_ms: Some(1000) }
        );
        assert_eq!(
            req(&["agent", "wait", "p1"]),
            Request::AgentWait { target: Target::Pane(1), until: Until::Settled, timeout_ms: Some(DEFAULT_WAIT_TIMEOUT_MS) }
        );
        assert!(usage_err(&["agent", "wait", "p1", "--until", "done"]).contains("--until"));
        assert_eq!(
            req(&["agent", "send-keys", "p1", "esc", "ctrl+c"]),
            Request::AgentSendKeys { target: Target::Pane(1), keys: vec!["esc".into(), "ctrl+c".into()] }
        );
        assert!(usage_err(&["agent", "send-keys", "p1", "esc", "ctrl+1"]).contains("unknown key"));
        assert!(usage_err(&["agent", "send-keys", "p1"]).starts_with("usage:"));
        assert_eq!(
            req(&["agent", "rename", "p1", "reviewer"]),
            Request::AgentRename { target: Target::Pane(1), handle: Some("reviewer".into()) }
        );
        assert_eq!(req(&["agent", "rename", "reviewer"]), Request::AgentRename { target: Target::Handle("reviewer".into()), handle: None });
        assert!(usage_err(&["agent", "rename", "p1", "Bad.Name"]).contains("not a valid"));
        // Capitals and spaces are fine now (ADR-0055); stored trimmed.
        assert_eq!(
            req(&["agent", "rename", "p1", " Agent  Two "]),
            Request::AgentRename { target: Target::Pane(1), handle: Some("Agent Two".into()) }
        );
    }

    #[test]
    fn keys() {
        for k in ["enter", "esc", "shift+tab", "ctrl+c", "pagedown"] {
            assert!(valid_key(k), "{k}");
        }
        for k in ["ctrl+", "ctrl+C", "ctrl+ab", "alt+x", "ESC", ""] {
            assert!(!valid_key(k), "{k}");
        }
    }

    #[test]
    fn requests_serialise_with_an_op_tag() {
        let v = serde_json::to_value(req(&["agent", "prompt", "p2", "go", "--wait"])).unwrap();
        assert_eq!(v["op"], "agent.prompt");
        assert_eq!(v["target"], json!({ "kind": "pane", "value": 2 }));
        assert_eq!(v["timeoutMs"], json!(DEFAULT_WAIT_TIMEOUT_MS));
        let v = serde_json::to_value(req(&["agent", "send-keys", "reviewer", "esc"])).unwrap();
        assert_eq!(v["op"], "agent.sendKeys");
        assert_eq!(v["target"], json!({ "kind": "handle", "value": "reviewer" }));
    }

    #[test]
    fn retries_of_mutating_calls_are_marked() {
        assert!(!is_mutating(&Request::PaneList));
        assert!(!is_mutating(&req(&["agent", "wait", "p1"])));
        assert!(is_mutating(&req(&["pane", "run", "p1", "ls"])));
        assert!(is_mutating(&req(&["agent", "prompt", "p1", "go"])));
    }

    #[test]
    fn nul_separated_arguments() {
        assert_eq!(split_nul_args(b"").unwrap(), Vec::<String>::new());
        assert_eq!(split_nul_args(b"pane\0list\0").unwrap(), argv(&["pane", "list"]));
        // An empty argument survives.
        assert_eq!(split_nul_args(b"a\0\0b\0").unwrap(), argv(&["a", "", "b"]));
        // A newline inside one argument stays inside it.
        assert_eq!(split_nul_args(b"agent\0prompt\0p1\0line1\nline2\0").unwrap()[3], "line1\nline2");
        assert!(split_nul_args(&[0xff, 0]).is_err());
    }

    #[test]
    fn window_replies_become_answers() {
        let ok = answer_from_reply(json!({ "result": { "panes": [] } }));
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body, r#"{"panes":[]}"#);
        let err = answer_from_reply(json!({ "error": { "code": "busy", "message": "Waiting" } }));
        assert_eq!(err.status, 409);
        assert!(err.body.contains(r#""code":"busy""#));
    }

    #[test]
    fn the_setting_defaults_to_on() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let store = crate::workspace_store::WorkspaceStore::new(conn);
        assert!(enabled(&store));
        store.set_setting(SETTING_KEY, "0").unwrap();
        assert!(!enabled(&store));
        store.set_setting(SETTING_KEY, "1").unwrap();
        assert!(enabled(&store));
    }
}

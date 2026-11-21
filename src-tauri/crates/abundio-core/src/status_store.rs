//! Every PTY's status, kept in Rust (ADR-0063, docs/plans/remote-hosts.md
//! phase 3).
//!
//! The same semantics as the frontend's `ptyActivityStore`, which today is the
//! authority: it runs the reducer on store-level events with the byte
//! heuristic and ESC fields reset each time (`hydrate` there), creates and
//! drops entries outside the reducer (`initPty`, `removePty`), records a
//! running shell command outside it (`setShellCommandRunning`), bumps the
//! activity time outside it (`touchLastOutput`, even for a PTY with no entry
//! yet, which a later fresh entry then picks up), and runs the idle scan as a
//! `tick` over every PTY.
//!
//! Since phase 3c this store is the authority: Windows still apply each change
//! at once (a prediction) and send it here (`status_apply`); Rust's answer
//! wins, and the idle scan runs only here (`start_ticker`). The shadow-mode
//! replay (`shadow`) remains as the test that the two agree.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::status_machine::{
    reduce, DotState, Mode, PreError, StatusConfig, StatusEvent, StatusState, Subagent,
};

#[derive(Default)]
pub struct StatusStore {
    by_pty: DashMap<String, StatusState>,
    /// Activity times for PTYs with no entry yet (`touchLastOutput` first).
    touched: DashMap<String, i64>,
    /// The Clients (Windows) each PTY's status updates go to: every Window
    /// that shows it (phase 9: two apps on one Host), the one that started
    /// it first.
    owners: DashMap<String, Vec<crate::event_sink::ClientId>>,
    /// Per-PTY update counter, so a Client never applies an older update
    /// over a newer one (command replies and tick events can interleave).
    seqs: DashMap<String, u64>,
    /// Each PTY's Agent, as its Window or a hook said, and what its terminal
    /// titles have said this agent session (**Title status**, ADR-0047,
    /// `title_status.rs`). Before a title has shown a status, a
    /// Title-status Agent's hooks are dropped.
    titles: DashMap<String, TitleEntry>,
    /// OpenCode 1.x: PTYs whose last turn was cancelled (`openCodeCancelGate`).
    open_code_cancelled: dashmap::DashSet<String>,
    /// The latest change Rust made by itself (a hook, an exit, a title, the
    /// idle scan) per PTY: its update's seq and cause. Every update names
    /// it, so a Window can tell a change it has not heard of yet from a
    /// wrong prediction of its own.
    host: DashMap<String, (u64, StatusEvent)>,
    /// PTYs whose shell started a command (not an Agent) that has not ended:
    /// only such a command's end counts. A shell reports an end at every
    /// prompt, the first one too, with the exit code of whatever ran last
    /// (its startup files, the command before an empty Enter).
    shell_started: dashmap::DashSet<String>,
    /// Each PTY's output heuristic (phase 6d-5): what `reduce_output` keeps
    /// between reads (bytes since idle, threshold crossings, the last read
    /// and the last input). Only output carries it into the reducer.
    gates: DashMap<String, OutputGate>,
    /// The **Activity byte threshold** setting; 0 means the default.
    byte_threshold: std::sync::atomic::AtomicI64,
}

#[derive(Debug, Clone, Default)]
struct OutputGate {
    bytes_since_idle: i64,
    threshold_hit_times: Vec<i64>,
    last_input_at: i64,
    last_output_chunk_at: Option<i64>,
}

#[derive(Default)]
struct TitleEntry {
    agent: Option<String>,
    track: crate::title_status::TitleTrack,
    /// Bumped whenever a grace window must no longer end the Turn.
    grace: u64,
}

impl TitleEntry {
    fn reset(&mut self) {
        self.track = Default::default();
        self.grace += 1;
    }
}

/// What a title did (`StatusStore::title_changed`).
#[derive(Debug, Default)]
pub struct TitleOutcome {
    pub update: Option<StatusUpdate>,
    /// A grace window to run: call `title_grace_ended` with this after
    /// `title_status::TURN_END_GRACE_MS`.
    pub grace: Option<u64>,
}

/// What the frontend store keeps of a PTY's status: its entry plus the
/// out-of-band maps. The fields compared in shadow mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreView {
    pub state: DotState,
    pub mode: Mode,
    pub hook_driven: bool,
    pub shell_command_running: bool,
    pub working_since: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub active_subagents: Vec<Subagent>,
    pub stop_held_for_subagents: bool,
    pub pre_error_state: Option<PreError>,
    pub title_held: bool,
}

impl From<&StatusState> for StoreView {
    fn from(s: &StatusState) -> Self {
        Self {
            state: s.state,
            mode: s.mode,
            hook_driven: s.hook_driven,
            shell_command_running: s.shell_command_running,
            working_since: s.working_since,
            last_activity_at: s.last_activity_at,
            active_subagents: s.active_subagents.clone(),
            stop_held_for_subagents: s.stop_held_for_subagents,
            pre_error_state: s.pre_error_state,
            title_held: s.title_held,
        }
    }
}

/// The frontend's `hydrate`: the heuristic and ESC fields never survive
/// between store-level events (terminalManager keeps those itself).
fn hydrate(s: Option<StatusState>, touched: Option<i64>) -> StatusState {
    let mut s = s.unwrap_or_else(|| {
        let mut fresh = StatusState::initial(Mode::Shell);
        fresh.last_activity_at = touched;
        fresh
    });
    s.bytes_since_idle = 0;
    s.threshold_hit_times = Vec::new();
    s.last_input_at = 0;
    s.last_output_chunk_at = None;
    s.last_esc_at = None;
    s
}

impl StatusStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// `initPty`: a fresh Idle entry, or only the mode changed on an existing
    /// one.
    pub fn init(&self, pty_id: &str, mode: Option<Mode>) {
        if let Some(mut existing) = self.by_pty.get_mut(pty_id) {
            if let Some(m) = mode {
                existing.mode = m;
            }
            return;
        }
        let mut fresh = StatusState::initial(mode.unwrap_or(Mode::Shell));
        // The frontend's activity map outlives entries: a time recorded
        // before the entry existed is read by the fresh one.
        fresh.last_activity_at = self.touched.remove(pty_id).map(|(_, t)| t);
        self.by_pty.insert(pty_id.to_string(), fresh);
    }

    /// `touchLastOutput`: output was seen; only the activity time moves.
    pub fn touch(&self, pty_id: &str, now: i64) {
        match self.by_pty.get_mut(pty_id) {
            Some(mut s) => s.last_activity_at = Some(now),
            None => {
                self.touched.insert(pty_id.to_string(), now);
            }
        }
    }

    /// `setShellCommandRunning`: records the flag only, on an existing entry.
    pub fn set_shell_command_running(&self, pty_id: &str, running: bool) {
        if let Some(mut s) = self.by_pty.get_mut(pty_id) {
            s.shell_command_running = running;
        }
    }

    /// One store-level event (`applyStatusEvent`). An absent PTY starts as an
    /// Idle shell, as the frontend's `hydrate(undefined)` does.
    pub fn apply(&self, pty_id: &str, event: &StatusEvent, config: &StatusConfig) -> StoreView {
        let touched = self.touched.remove(pty_id).map(|(_, t)| t);
        let mut before = hydrate(self.by_pty.get(pty_id).map(|s| s.clone()), touched);
        let output = matches!(event, StatusEvent::Output { .. });
        if output {
            if let Some(g) = self.gates.get(pty_id) {
                before.bytes_since_idle = g.bytes_since_idle;
                before.threshold_hit_times = g.threshold_hit_times.clone();
                before.last_input_at = g.last_input_at;
                before.last_output_chunk_at = g.last_output_chunk_at;
            }
        }
        let after = reduce(before, event, config);
        if output {
            self.gates.insert(
                pty_id.to_string(),
                OutputGate {
                    bytes_since_idle: after.bytes_since_idle,
                    threshold_hit_times: after.threshold_hit_times.clone(),
                    last_input_at: after.last_input_at,
                    last_output_chunk_at: after.last_output_chunk_at,
                },
            );
        }
        let view = StoreView::from(&after);
        self.by_pty.insert(pty_id.to_string(), after);
        view
    }

    /// The idle scan over every PTY. Only a state change, or a stale Subagent
    /// pruned, is kept — as the frontend's scanner does.
    pub fn tick(&self, now: i64, config: &StatusConfig) {
        for mut entry in self.by_pty.iter_mut() {
            let before = hydrate(Some(entry.clone()), None);
            let after = reduce(before.clone(), &StatusEvent::Tick { now, rule: None }, config);
            if after.active_subagents != before.active_subagents {
                entry.active_subagents = after.active_subagents.clone();
                entry.stop_held_for_subagents = after.stop_held_for_subagents;
            }
            if after.state != before.state {
                *entry = after;
            }
        }
    }

    pub fn remove(&self, pty_id: &str) {
        self.by_pty.remove(pty_id);
        self.touched.remove(pty_id);
        self.owners.remove(pty_id);
    }

    pub fn view(&self, pty_id: &str) -> Option<StoreView> {
        self.by_pty.get(pty_id).map(|s| StoreView::from(&*s))
    }
}

// ── The authority (phase 3c) ──
//
// The frontend sends each status operation here (`status_apply`) and shows
// what comes back; the idle scan runs here on its own clock and sends its
// changes as `status-updates` events to the PTY's Window.

/// The part of a status the frontend's change listeners see (notifications,
/// Turn telemetry): `StatusSnapshot` there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: DotState,
    pub detection_mode: Mode,
    pub hook_driven: bool,
}

impl From<&StoreView> for Snapshot {
    fn from(v: &StoreView) -> Self {
        Self {
            state: v.state,
            detection_mode: v.mode,
            hook_driven: v.hook_driven,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub prev: Snapshot,
    pub next: Snapshot,
    pub cause: StatusEvent,
}

/// What a Window applies for one PTY: its new view (`None`: the entry is
/// gone) and, when the frontend would have announced one, the change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub pty_id: String,
    pub seq: u64,
    pub view: Option<StoreView>,
    pub change: Option<Change>,
    /// See `StatusStore::host`: the latest change Rust made by itself, as
    /// of this update (its seq and cause).
    pub host_seq: Option<u64>,
    pub host_cause: Option<StatusEvent>,
}

/// One status operation from a Window: the store actions of
/// `ptyActivityStore`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StatusOp {
    Init { pty_id: String, mode: Option<Mode> },
    ShellCommandRunning { pty_id: String, running: bool },
    Apply { pty_id: String, event: StatusEvent },
    Touch { pty_id: String, now: i64 },
    Remove { pty_id: String },
    /// Which Agent the PTY runs, as the Window detected it, or none.
    Agent { pty_id: String, agent_id: Option<String> },
}

/// The fields of the frontend's `PtyActivityEntry` that decide whether an
/// event "changed" the entry (`entriesEqual` there).
fn entry_key(v: &StoreView) -> (DotState, Option<i64>, Mode, bool, bool) {
    (v.state, v.working_since, v.mode, v.hook_driven, v.shell_command_running)
}

impl StatusStore {
    fn next_seq(&self, pty_id: &str) -> u64 {
        let mut e = self.seqs.entry(pty_id.to_string()).or_insert(0);
        *e += 1;
        *e
    }

    fn update(&self, pty_id: &str, change: Option<Change>) -> StatusUpdate {
        let host = self.host.get(pty_id).map(|h| h.clone());
        StatusUpdate {
            pty_id: pty_id.to_string(),
            seq: self.next_seq(pty_id),
            view: self.view(pty_id),
            change,
            host_seq: host.as_ref().map(|h| h.0),
            host_cause: host.map(|h| h.1),
        }
    }

    /// Remember an update Rust made by itself (see `host`).
    fn by_host(&self, update: Option<StatusUpdate>) -> Option<StatusUpdate> {
        if let Some(u) = &update {
            if let Some(c) = &u.change {
                self.host.insert(u.pty_id.clone(), (u.seq, c.cause.clone()));
            }
        }
        update
    }

    /// Run one operation from `client`; what that Window should apply.
    /// `None` when nothing it shows changed.
    pub fn run_op(
        &self,
        client: &crate::event_sink::ClientId,
        op: StatusOp,
        config: &StatusConfig,
    ) -> Option<StatusUpdate> {
        match op {
            StatusOp::Init { pty_id, mode } => {
                // A Window attaching to a running pane (another app, or this
                // one after a reload, its store empty) takes its status as
                // it is now.
                let existed = self.by_pty.contains_key(&pty_id);
                self.watch(&pty_id, client);
                let before = self.view(&pty_id);
                self.init(&pty_id, mode);
                (existed || self.view(&pty_id) != before).then(|| self.update(&pty_id, None))
            }
            StatusOp::ShellCommandRunning { pty_id, running } => {
                let before = self.view(&pty_id);
                self.set_shell_command_running(&pty_id, running);
                (self.view(&pty_id) != before).then(|| self.update(&pty_id, None))
            }
            StatusOp::Touch { pty_id, now } => {
                // The Window keeps its own copy of the activity time; nothing
                // to send back for the hottest operation there is.
                self.touch(&pty_id, now);
                None
            }
            StatusOp::Agent { pty_id, agent_id } => {
                self.set_agent(&pty_id, agent_id);
                None
            }
            StatusOp::Remove { pty_id } => {
                self.titles.remove(&pty_id);
                self.host.remove(&pty_id);
                self.shell_started.remove(&pty_id);
                self.gates.remove(&pty_id);
                self.open_code_cancelled.remove(&pty_id);
                let existed = self.by_pty.contains_key(&pty_id);
                self.remove(&pty_id);
                let update = existed.then(|| self.update(&pty_id, None));
                self.seqs.remove(&pty_id);
                update
            }
            StatusOp::Apply { pty_id, event } => {
                if !self.owners.contains_key(&pty_id) {
                    self.watch(&pty_id, client);
                }
                self.apply_change(&pty_id, event, config)
            }
        }
    }

    /// Apply `event` and say what the owning Window should take: the new
    /// view, and the change (with `event` as its cause) when the status moved
    /// or a Turn started. `None` when nothing it shows changed.
    fn apply_change(
        &self,
        pty_id: &str,
        event: StatusEvent,
        config: &StatusConfig,
    ) -> Option<StatusUpdate> {
        let before = self.view(pty_id);
        let prev_view = before
            .clone()
            .unwrap_or_else(|| StoreView::from(&StatusState::initial(Mode::Shell)));
        let after = self.apply(pty_id, &event, config);
        if before.as_ref().is_some_and(|b| b.mode != after.mode) {
            // Into or out of agent mode: a new agent session's titles, and
            // no shell command of its own.
            if let Some(mut t) = self.titles.get_mut(pty_id) {
                t.reset();
            }
            self.shell_started.remove(pty_id);
        }
        let changed = match &before {
            None => true,
            Some(b) => entry_key(b) != entry_key(&after),
        };
        let starts_turn = crate::status_machine::event_starts_turn(&event);
        let change = (changed || starts_turn).then(|| Change {
            prev: Snapshot::from(&prev_view),
            next: Snapshot::from(&after),
            cause: event,
        });
        (before.as_ref() != Some(&after) || change.is_some()).then(|| self.update(pty_id, change))
    }

    /// Apply an event the Host saw itself (a hook, an exit): what the owning
    /// Window should take, if anything changed.
    pub fn apply_from_host(&self, pty_id: &str, event: StatusEvent, config: &StatusConfig) -> Option<StatusUpdate> {
        self.by_host(self.apply_change(pty_id, event, config))
    }

    /// Whether the PTY has a status yet (a Window's `initPty`, or an event).
    pub fn has(&self, pty_id: &str) -> bool {
        self.by_pty.contains_key(pty_id)
    }

    /// The Window that started showing a PTY first (where its Agent
    /// control and hook notices are routed).
    pub fn owner(&self, pty_id: &str) -> Option<crate::event_sink::ClientId> {
        self.owners.get(pty_id).and_then(|o| o.first().cloned())
    }

    /// Every Window a PTY's status updates go to.
    pub fn watchers(&self, pty_id: &str) -> Vec<crate::event_sink::ClientId> {
        self.owners.get(pty_id).map(|o| o.clone()).unwrap_or_default()
    }

    fn watch(&self, pty_id: &str, client: &crate::event_sink::ClientId) {
        let mut list = self.owners.entry(pty_id.to_string()).or_default();
        if !list.contains(client) {
            list.push(client.clone());
        }
    }

    pub fn title_status_seen(&self, pty_id: &str) -> bool {
        self.titles.get(pty_id).is_some_and(|t| t.track.seen)
    }

    /// Which Agent the PTY runs. A different one starts its titles afresh.
    pub fn set_agent(&self, pty_id: &str, agent: Option<String>) {
        let mut t = self.titles.entry(pty_id.to_string()).or_default();
        if t.agent != agent {
            t.agent = agent;
            t.reset();
        }
    }

    /// The PTY's terminal title changed (`title_status::change`), in agent
    /// mode only: what the owning Window should take, and a grace window to
    /// run when the title ended a Turn.
    pub fn title_changed(&self, pty_id: &str, title: &str, now: i64, config: &StatusConfig) -> TitleOutcome {
        if !self.view(pty_id).is_some_and(|v| v.mode == Mode::Agent) {
            return TitleOutcome::default();
        }
        let (dispatch, grace) = {
            let mut t = self.titles.entry(pty_id.to_string()).or_default();
            let c = crate::title_status::change(t.track, t.agent.as_deref(), title);
            t.track = c.track;
            if c.dispatch.is_some() {
                t.grace += 1;
            }
            (c.dispatch, (c.await_turn_end).then_some(t.grace))
        };
        let Some(d) = dispatch else { return TitleOutcome::default() };
        let event = StatusEvent::Title { status: d.status, now, starts_turn: Some(d.starts_turn) };
        TitleOutcome { update: self.apply_from_host(pty_id, event, config), grace }
    }

    /// What the PTY's shell reported (shell integration, phase 6d-4), as the
    /// Window's output handler applied it: a typed Agent enters agent mode
    /// (`setAgentPty`); another command is Working (`setShellCommandRunning`,
    /// `recordOutput`); its end is an Error or a clean finish
    /// (`classifyShellExit`), and an Agent's end leaves agent mode
    /// (`applyAgentExit`). What the owning Window should take.
    pub fn shell_commands(
        &self,
        pty_id: &str,
        commands: &[crate::shell_integration::ShellCommand],
        agents: &crate::shell_integration::AgentCommands,
        now: i64,
        config: &StatusConfig,
    ) -> Vec<StatusUpdate> {
        use crate::shell_integration::ShellCommand;
        let mut out = Vec::new();
        for c in commands {
            let agent_mode = self.view(pty_id).is_some_and(|v| v.mode == Mode::Agent);
            match c {
                ShellCommand::Cwd { .. } => {}
                ShellCommand::CommandStart { command_text } => {
                    if let Some(id) = command_text.as_deref().and_then(|t| agents.matching(t)) {
                        self.set_agent(pty_id, Some(id));
                        if self.has(pty_id) && !agent_mode {
                            out.extend(self.apply_from_host(pty_id, StatusEvent::AgentDetected, config));
                        }
                    } else if !agent_mode {
                        self.shell_started.insert(pty_id.to_string());
                        out.extend(self.shell_flag(pty_id, true));
                        out.extend(self.apply_from_host(pty_id, StatusEvent::RecordOutput { now }, config));
                    }
                }
                ShellCommand::CommandEnd { exit_code } => {
                    if agent_mode {
                        out.extend(self.apply_from_host(pty_id, StatusEvent::AgentExited, config));
                        self.set_agent(pty_id, None);
                    } else if self.shell_started.remove(pty_id).is_some() {
                        out.extend(self.shell_flag(pty_id, false));
                        let failed = matches!(exit_code, Some(c) if *c != 0 && !SHELL_USER_STOP_CODES.iter().any(|s| i64::from(*s) == *c));
                        let event = if failed { StatusEvent::RecordError } else { StatusEvent::RecordExitSuccess };
                        out.extend(self.apply_from_host(pty_id, event, config));
                    }
                }
            }
        }
        out
    }

    /// Set the **Activity byte threshold** (the Window's setting).
    pub fn set_byte_threshold(&self, bytes: i64) {
        self.byte_threshold.store(bytes.max(1), std::sync::atomic::Ordering::Relaxed);
    }

    /// The status config, with the byte threshold the user set.
    pub fn config(&self) -> StatusConfig {
        match self.byte_threshold.load(std::sync::atomic::Ordering::Relaxed) {
            0 => StatusConfig::default(),
            n => StatusConfig { activity_byte_threshold: n },
        }
    }

    /// Input reached the PTY (a keystroke, a paste, a mouse report, an
    /// Agent control prompt; not a focus report, which is no input): output
    /// right after it is its echo, not the Agent at work (the input gate).
    pub fn input(&self, pty_id: &str, data: &[u8], now: i64) {
        if data == b"\x1b[I" || data == b"\x1b[O" {
            return;
        }
        let mut g = self.gates.entry(pty_id.to_string()).or_default();
        g.last_input_at = now;
        g.bytes_since_idle = 0;
    }

    /// One read of the PTY's output (`bytes` long), for the output heuristic
    /// of an agent-mode pane with no hooks (`reduce_output`; a hook-driven
    /// one only keeps its activity time). Only a change is worth telling a
    /// Window: the activity time alone moves with every read.
    pub fn output(&self, pty_id: &str, bytes: usize, now: i64) -> Option<StatusUpdate> {
        if !self.view(pty_id).is_some_and(|v| v.mode == Mode::Agent) {
            return None;
        }
        let event = StatusEvent::Output { bytes: bytes as i64, now };
        let update = self.apply_change(pty_id, event, &self.config())?;
        update.change.is_some().then_some(update).and_then(|u| self.by_host(Some(u)))
    }

    /// `setShellCommandRunning` seen by the Host: an update when the view
    /// changed.
    fn shell_flag(&self, pty_id: &str, running: bool) -> Option<StatusUpdate> {
        let before = self.view(pty_id);
        self.set_shell_command_running(pty_id, running);
        (self.view(pty_id) != before).then(|| self.update(pty_id, None))
    }

    /// A grace window ran out: unless a later title (or a new agent session)
    /// cancelled it, the Turn was cancelled or failed.
    pub fn title_grace_ended(&self, pty_id: &str, grace: u64, now: i64, config: &StatusConfig) -> Option<StatusUpdate> {
        {
            let mut t = self.titles.get_mut(pty_id)?;
            if t.grace != grace {
                return None;
            }
            t.track = crate::title_status::grace_ended(t.track);
        }
        if !self.has(pty_id) {
            return None;
        }
        self.apply_from_host(pty_id, StatusEvent::TitleTurnEnded { now }, config)
    }

    pub fn open_code_cancelled(&self, pty_id: &str) -> bool {
        self.open_code_cancelled.contains(pty_id)
    }

    pub fn set_open_code_cancelled(&self, pty_id: &str, cancelled: bool) {
        if cancelled {
            self.open_code_cancelled.insert(pty_id.to_string());
        } else {
            self.open_code_cancelled.remove(pty_id);
        }
    }

    /// The PTY exited (its process ended or was killed), seen by the Host
    /// itself: a failure (a non-zero code other than a user stop, 130 or 143)
    /// is an Error, anything else a clean exit, as `classifyShellExit` says.
    /// The status is kept even with no Window; the owning Window, if any, is
    /// told with the change. A clean exit of a PTY with no status is nothing.
    pub fn exit_update(
        &self,
        pty_id: &str,
        code: Option<u32>,
        config: &StatusConfig,
    ) -> Vec<(crate::event_sink::ClientId, StatusUpdate)> {
        let failed = matches!(code, Some(c) if c != 0 && !SHELL_USER_STOP_CODES.contains(&c));
        if !failed && !self.by_pty.contains_key(pty_id) {
            return Vec::new();
        }
        let event = if failed { StatusEvent::RecordError } else { StatusEvent::RecordExitSuccess };
        let Some(update) = self.apply_from_host(pty_id, event, config) else { return Vec::new() };
        self.watchers(pty_id).into_iter().map(|w| (w, update.clone())).collect()
    }

    /// The idle scan, with what each Window should apply. A change names the
    /// backstop it tripped (`backstopRule` in the frontend): live Subagents
    /// before the tick mean `subagent_drain`, anything else `idle_backstop`.
    pub fn tick_updates(
        &self,
        now: i64,
        config: &StatusConfig,
    ) -> Vec<(crate::event_sink::ClientId, StatusUpdate)> {
        let before: Vec<(String, StoreView)> = self
            .by_pty
            .iter()
            .map(|e| (e.key().clone(), StoreView::from(&*e)))
            .collect();
        self.tick(now, config);
        let mut out = Vec::new();
        for (pty_id, b) in before {
            let Some(after) = self.view(&pty_id) else { continue };
            if after == b {
                continue;
            }
            let watchers = self.watchers(&pty_id);
            if watchers.is_empty() {
                continue;
            }
            let change = (after.state != b.state).then(|| Change {
                prev: Snapshot::from(&b),
                next: Snapshot::from(&after),
                cause: StatusEvent::Tick {
                    now,
                    rule: Some(
                        if b.active_subagents.is_empty() {
                            "idle_backstop"
                        } else {
                            "subagent_drain"
                        }
                        .to_string(),
                    ),
                },
            });
            if let Some(u) = self.by_host(Some(self.update(&pty_id, change))) {
                out.extend(watchers.into_iter().map(|w| (w, u.clone())));
            }
        }
        out
    }

    /// A Client went away from a Host, whose PTYs keep running: their
    /// status is kept, and sent to the other Windows that show them, or to
    /// the next one that does.
    pub fn release_client(&self, client: &str) {
        for mut list in self.owners.iter_mut() {
            list.retain(|c| c.as_str() != client);
        }
        self.owners.retain(|_, list| !list.is_empty());
    }

    /// A closed Window's PTYs that no other Window shows are forgotten
    /// with it (on the desktop they die with it).
    pub fn forget_client(&self, client: &str) {
        let mut gone = Vec::new();
        for mut e in self.owners.iter_mut() {
            let before = e.len();
            e.retain(|c| c.as_str() != client);
            if e.is_empty() && before > 0 {
                gone.push(e.key().clone());
            }
        }
        for id in gone {
            self.remove(&id);
            self.seqs.remove(&id);
        }
    }
}

/// Exit codes of a shell or program the user stopped (Ctrl+C, a kill):
/// not failures (`SHELL_USER_STOP_CODES` in the frontend).
pub const SHELL_USER_STOP_CODES: [u32; 2] = [130, 143];

/// How often the idle scan runs (`SCAN_INTERVAL_MS` in the frontend).
pub const SCAN_INTERVAL_MS: u64 = 2000;

/// Run the idle scan on its own thread for the life of the app, sending each
/// Window the updates for its PTYs as one `status-updates` event.
pub fn start_ticker(store: std::sync::Arc<StatusStore>, events: crate::event_sink::Events) {
    use crate::event_sink::EventsExt;
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(SCAN_INTERVAL_MS));
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut by_client: std::collections::HashMap<crate::event_sink::ClientId, Vec<StatusUpdate>> =
            std::collections::HashMap::new();
        for (client, update) in store.tick_updates(now, &StatusConfig::default()) {
            by_client.entry(client).or_default().push(update);
        }
        for (client, updates) in by_client {
            events.to_client(&client, "status-updates", updates);
        }
    });
}

/// Run the output heuristic on every PTY's output and input (phase 6d-5),
/// telling each PTY's owning Window (if any) what changed.
pub fn listen_activity(
    ptys: &crate::pty_manager::PtyManager,
    store: std::sync::Arc<StatusStore>,
    events: crate::event_sink::Events,
) {
    use crate::event_sink::EventsExt;
    let input = store.clone();
    ptys.on_input(std::sync::Arc::new(move |pty: &str, data: &[u8]| {
        input.input(pty, data, crate::hook_apply::now_ms());
    }));
    ptys.on_output(std::sync::Arc::new(move |pty: &str, data: &[u8]| {
        if let Some(update) = store.output(pty, data.len(), crate::hook_apply::now_ms()) {
            for watcher in store.watchers(pty) {
                events.to_client(&watcher, "status-updates", vec![update.clone()]);
            }
        }
    }));
}

/// One mirrored operation in shadow mode, with the frontend's result.
#[cfg(test)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ShadowOp {
    Init {
        pty_id: String,
        mode: Option<Mode>,
        expected: Option<StoreView>,
    },
    ShellCommandRunning {
        pty_id: String,
        running: bool,
        expected: Option<StoreView>,
    },
    Apply {
        pty_id: String,
        event: StatusEvent,
        threshold: Option<i64>,
        expected: Option<StoreView>,
    },
    /// The scanner's tick, with the frontend's view of every PTY after it.
    Tick {
        now: i64,
        expected: std::collections::HashMap<String, StoreView>,
    },
    Touch {
        pty_id: String,
        now: i64,
        expected: Option<StoreView>,
    },
    Remove {
        pty_id: String,
    },
}

/// A difference shadow mode found.
#[cfg(test)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowMismatch {
    pub pty_id: String,
    pub op: String,
    pub frontend: Option<StoreView>,
    pub rust: Option<StoreView>,
}

#[cfg(test)]
impl StatusStore {
    /// Run mirrored operations in order; return every difference.
    pub fn shadow(&self, ops: Vec<ShadowOp>) -> Vec<ShadowMismatch> {
        let mut out = Vec::new();
        let mut check = |pty_id: &str, op: &str, expected: Option<StoreView>, store: &Self| {
            let rust = store.view(pty_id);
            if rust != expected {
                out.push(ShadowMismatch {
                    pty_id: pty_id.to_string(),
                    op: op.to_string(),
                    frontend: expected,
                    rust,
                });
            }
        };
        for op in ops {
            match op {
                ShadowOp::Init { pty_id, mode, expected } => {
                    self.init(&pty_id, mode);
                    check(&pty_id, "init", expected, self);
                }
                ShadowOp::ShellCommandRunning { pty_id, running, expected } => {
                    self.set_shell_command_running(&pty_id, running);
                    check(&pty_id, "shellCommandRunning", expected, self);
                }
                ShadowOp::Apply { pty_id, event, threshold, expected } => {
                    let config = StatusConfig {
                        activity_byte_threshold: threshold
                            .unwrap_or(StatusConfig::default().activity_byte_threshold),
                    };
                    let name = serde_json::to_value(&event)
                        .ok()
                        .and_then(|v| v["kind"].as_str().map(str::to_string))
                        .unwrap_or_default();
                    self.apply(&pty_id, &event, &config);
                    check(&pty_id, &name, expected, self);
                }
                ShadowOp::Tick { now, expected } => {
                    self.tick(now, &StatusConfig::default());
                    // Only the sending Window's PTYs: other Windows' live in
                    // this store too, and their own ticks check them.
                    let mut ids: Vec<&String> = expected.keys().collect();
                    ids.sort();
                    for id in ids {
                        check(id, "tick", expected.get(id).cloned(), self);
                    }
                }
                ShadowOp::Touch { pty_id, now, expected } => {
                    self.touch(&pty_id, now);
                    check(&pty_id, "touch", expected, self);
                }
                ShadowOp::Remove { pty_id } => self.remove(&pty_id),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_machine::Transition;

    fn hook(t: Transition, now: i64) -> StatusEvent {
        StatusEvent::Hook { transition: t, now, starts_turn: None }
    }

    #[test]
    fn an_absent_pty_starts_as_an_idle_shell() {
        let store = StatusStore::new();
        let v = store.apply("p", &StatusEvent::RecordError, &StatusConfig::default());
        assert_eq!(v.state, DotState::Error);
        assert_eq!(v.mode, Mode::Shell);
    }

    #[test]
    fn init_only_changes_the_mode_of_an_existing_entry() {
        let store = StatusStore::new();
        store.init("p", Some(Mode::Agent));
        store.apply("p", &hook(Transition::Working, 1), &StatusConfig::default());
        store.init("p", Some(Mode::Shell));
        let v = store.view("p").unwrap();
        assert_eq!(v.state, DotState::Working);
        assert_eq!(v.mode, Mode::Shell);
    }

    #[test]
    fn only_output_keeps_the_heuristic_between_events() {
        let store = StatusStore::new();
        store.init("p", Some(Mode::Agent));
        let c = StatusConfig::default();
        // Output carries its counters from one read to the next (phase
        // 6d-5); any other event starts them empty, as the frontend store's
        // `hydrate` does, so a keystroke event is no input here (`input` is).
        store.apply("p", &StatusEvent::Keystroke { key: crate::status_machine::Key::Other, esc_required: 2, now: 10_000 }, &c);
        for i in 0..5 {
            store.apply("p", &StatusEvent::Output { bytes: 2000, now: 10_001 + i }, &c);
        }
        assert_eq!(store.view("p").unwrap().state, DotState::Working);
    }

    #[test]
    fn the_tick_moves_a_silent_working_agent_to_ready() {
        let store = StatusStore::new();
        store.init("p", Some(Mode::Agent));
        store.apply("p", &hook(Transition::Working, 1_000), &StatusConfig::default());
        store.tick(1_000 + 30_001, &StatusConfig::default());
        assert_eq!(store.view("p").unwrap().state, DotState::Ready);
    }

    #[test]
    fn shadow_reports_a_difference_and_nothing_when_they_agree() {
        let store = StatusStore::new();
        let mut agent = StoreView::from(&StatusState::initial(Mode::Agent));
        let ok = store.shadow(vec![ShadowOp::Init {
            pty_id: "p".into(),
            mode: Some(Mode::Agent),
            expected: Some(agent.clone()),
        }]);
        assert!(ok.is_empty());
        agent.state = DotState::Ready;
        let bad = store.shadow(vec![ShadowOp::Apply {
            pty_id: "p".into(),
            event: StatusEvent::Focus,
            threshold: None,
            expected: Some(agent),
        }]);
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].op, "focus");
        assert_eq!(bad[0].rust.as_ref().unwrap().state, DotState::Idle);
    }

    /// The real frontend store, driven through random actions with its
    /// scanner ticking (`statusShadowStore.test.ts`): replayed here, nothing
    /// may differ.
    #[test]
    fn replays_the_frontend_store_without_a_difference() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/statusShadowStore.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut ops_seen = 0;
        for (i, run) in doc["runs"].as_array().unwrap().iter().enumerate() {
            let ops: Vec<ShadowOp> = serde_json::from_value(run["ops"].clone())
                .unwrap_or_else(|e| panic!("run {i}: {e}"));
            ops_seen += ops.len();
            let store = StatusStore::new();
            let mismatches = store.shadow(ops);
            assert!(mismatches.is_empty(), "run {i}: {:#?}", &mismatches[..mismatches.len().min(3)]);
        }
        assert!(ops_seen > 1000, "only {ops_seen} ops");
    }

    /// The same recording through the authority API the Windows use: every
    /// view must match, and the changes announced (which drive notifications
    /// and Turn telemetry) must be the frontend's, in order, cause included.
    #[test]
    fn as_the_authority_matches_the_frontend_store() {
        use crate::event_sink::ClientId;
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/statusShadowStore.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let client = ClientId::from("window-1");
        let config = StatusConfig::default();
        let mut changes_checked = 0;
        for (i, run) in doc["runs"].as_array().unwrap().iter().enumerate() {
            let ops: Vec<ShadowOp> = serde_json::from_value(run["ops"].clone()).unwrap();
            let store = StatusStore::new();
            let mut got: Vec<serde_json::Value> = Vec::new();
            let mut push = |u: &StatusUpdate| {
                if let Some(c) = &u.change {
                    got.push(serde_json::json!({
                        "ptyId": u.pty_id,
                        "prev": c.prev,
                        "next": c.next,
                        "cause": c.cause,
                    }));
                }
            };
            for (j, op) in ops.into_iter().enumerate() {
                let (pty, expected) = match op {
                    ShadowOp::Init { pty_id, mode, expected } => {
                        if let Some(u) = store.run_op(&client, StatusOp::Init { pty_id: pty_id.clone(), mode }, &config) { push(&u) }
                        (Some(pty_id), expected)
                    }
                    ShadowOp::ShellCommandRunning { pty_id, running, expected } => {
                        if let Some(u) = store.run_op(&client, StatusOp::ShellCommandRunning { pty_id: pty_id.clone(), running }, &config) { push(&u) }
                        (Some(pty_id), expected)
                    }
                    ShadowOp::Apply { pty_id, event, expected, .. } => {
                        if let Some(u) = store.run_op(&client, StatusOp::Apply { pty_id: pty_id.clone(), event }, &config) { push(&u) }
                        (Some(pty_id), expected)
                    }
                    ShadowOp::Touch { pty_id, now, expected } => {
                        store.run_op(&client, StatusOp::Touch { pty_id: pty_id.clone(), now }, &config);
                        (Some(pty_id), expected)
                    }
                    ShadowOp::Remove { pty_id } => {
                        store.run_op(&client, StatusOp::Remove { pty_id }, &config);
                        (None, None)
                    }
                    ShadowOp::Tick { now, expected } => {
                        for (owner, u) in store.tick_updates(now, &config) {
                            assert_eq!(owner, client);
                            push(&u);
                        }
                        for (id, v) in expected {
                            assert_eq!(store.view(&id), Some(v), "run {i} op {j} tick {id}");
                        }
                        (None, None)
                    }
                };
                if let Some(p) = pty {
                    assert_eq!(store.view(&p), expected, "run {i} op {j}");
                }
            }
            let want = run["changes"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "run {i}: {} changes, frontend {}", got.len(), want.len());
            for (k, (g, w)) in got.iter().zip(want).enumerate() {
                assert_eq!(g, w, "run {i} change {k}");
            }
            changes_checked += want.len();
        }
        assert!(changes_checked > 300, "only {changes_checked} changes");
    }

    #[test]
    fn an_exit_seen_by_the_host_tells_the_owning_window() {
        use crate::event_sink::ClientId;
        let store = StatusStore::new();
        let config = StatusConfig::default();
        let w = ClientId::from("window-1");
        store.run_op(&w, StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Agent) }, &config);
        store.run_op(
            &w,
            StatusOp::Apply {
                pty_id: "p".into(),
                event: StatusEvent::Hook { transition: crate::status_machine::Transition::Working, now: 1, starts_turn: None },
            },
            &config,
        );
        let (to, u) = store.exit_update("p", Some(1), &config).pop().unwrap();
        assert_eq!(to, w);
        assert_eq!(u.view.unwrap().state, DotState::Error);
        assert_eq!(u.change.unwrap().cause, StatusEvent::RecordError);
    }

    #[test]
    fn a_user_stop_is_a_clean_exit_and_an_unknown_clean_exit_is_nothing() {
        use crate::event_sink::ClientId;
        let store = StatusStore::new();
        let config = StatusConfig::default();
        store.run_op(&ClientId::from("w"), StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Shell) }, &config);
        store.run_op(
            &ClientId::from("w"),
            StatusOp::Apply { pty_id: "p".into(), event: StatusEvent::ShellCommandStarted { now: 1 } },
            &config,
        );
        let (_, u) = store.exit_update("p", Some(130), &config).pop().unwrap();
        assert_eq!(u.change.unwrap().cause, StatusEvent::RecordExitSuccess);
        assert!(store.exit_update("never-seen", Some(0), &config).is_empty());
        assert!(store.exit_update("never-seen", None, &config).is_empty());
    }

    #[test]
    fn a_host_keeps_an_exit_with_no_window_to_tell() {
        let store = StatusStore::new();
        let config = StatusConfig::default();
        assert!(store.exit_update("p", Some(2), &config).is_empty());
        assert_eq!(store.view("p").unwrap().state, DotState::Error);
    }

    #[test]
    fn reads_the_windows_agent_op() {
        let op: StatusOp = serde_json::from_str(r#"{"op":"agent","ptyId":"p","agentId":"vibe"}"#).unwrap();
        let store = StatusStore::new();
        assert!(store.run_op(&crate::event_sink::ClientId::from("w"), op, &StatusConfig::default()).is_none());
        assert_eq!(store.titles.get("p").unwrap().agent.as_deref(), Some("vibe"));
        let op: StatusOp = serde_json::from_str(r#"{"op":"agent","ptyId":"p","agentId":null}"#).unwrap();
        store.run_op(&crate::event_sink::ClientId::from("w"), op, &StatusConfig::default());
        assert_eq!(store.titles.get("p").unwrap().agent, None);
    }

    fn vibe_pane() -> StatusStore {
        let store = StatusStore::new();
        let w = crate::event_sink::ClientId::from("w");
        let config = StatusConfig::default();
        store.run_op(&w, StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Agent) }, &config);
        store.set_agent("p", Some("vibe".into()));
        store
    }

    fn shell(store: &StatusStore, chunk: &str, now: i64) -> Vec<StatusUpdate> {
        let mut p = crate::shell_integration::Parser::default();
        let agents = crate::shell_integration::AgentCommands::default();
        store.shell_commands("p", &p.parse(chunk.as_bytes()), &agents, now, &StatusConfig::default())
    }

    fn shell_pane() -> StatusStore {
        let store = StatusStore::new();
        let w = crate::event_sink::ClientId::from("w");
        store.run_op(&w, StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Shell) }, &StatusConfig::default());
        store
    }

    fn agent_pane() -> StatusStore {
        let store = StatusStore::new();
        let w = crate::event_sink::ClientId::from("w");
        store.run_op(&w, StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Agent) }, &StatusConfig::default());
        store
    }

    #[test]
    fn sustained_output_makes_an_agent_with_no_hooks_work() {
        let store = agent_pane();
        // Five crossings of the threshold within five seconds.
        for t in 0..4 {
            assert!(store.output("p", 2000, 10_000 + t * 500).is_none());
        }
        let u = store.output("p", 2000, 12_000).unwrap();
        assert!(matches!(u.change.unwrap().cause, StatusEvent::Output { .. }));
        assert_eq!(store.view("p").unwrap().state, DotState::Working);
        // More output only keeps the activity time: nothing to tell.
        assert!(store.output("p", 2000, 12_100).is_none());
        assert_eq!(store.view("p").unwrap().last_activity_at, Some(12_100));
    }

    #[test]
    fn output_right_after_input_is_its_echo() {
        let store = agent_pane();
        for t in 0..10 {
            store.input("p", b"x", 10_000 + t * 200);
            assert!(store.output("p", 5000, 10_000 + t * 200 + 50).is_none());
        }
        assert_eq!(store.view("p").unwrap().state, DotState::Idle);
        // A focus report is not input.
        store.input("p", b"\x1b[I", 20_000);
        for t in 0..5 {
            store.output("p", 2000, 20_100 + t * 100);
        }
        assert_eq!(store.view("p").unwrap().state, DotState::Working);
    }

    #[test]
    fn the_byte_threshold_follows_the_setting() {
        let store = agent_pane();
        store.set_byte_threshold(100_000);
        for t in 0..5 {
            store.output("p", 2000, 10_000 + t * 100);
        }
        assert_eq!(store.view("p").unwrap().state, DotState::Idle);
        // A shell's output is never activity.
        let shell = shell_pane();
        for t in 0..5 {
            assert!(shell.output("p", 2000, 10_000 + t * 100).is_none());
        }
    }

    #[test]
    fn a_shell_command_works_then_fails_or_finishes() {
        let store = shell_pane();
        shell(&store, "\x1b]7770;command_start;make\x07", 1);
        let v = store.view("p").unwrap();
        assert_eq!((v.state, v.shell_command_running), (DotState::Working, true));
        shell(&store, "\x1b]7770;command_end;2\x07", 2);
        let v = store.view("p").unwrap();
        assert_eq!((v.state, v.shell_command_running), (DotState::Error, false));
        store.apply("p", &StatusEvent::Focus, &StatusConfig::default());
        store.apply("p", &StatusEvent::Click, &StatusConfig::default());
        shell(&store, "\x1b]7770;command_start;sleep 9\x07", 3);
        shell(&store, "\x1b]7770;command_end;130\x07", 4);
        assert_eq!(store.view("p").unwrap().state, DotState::Idle);
    }

    #[test]
    fn a_prompt_with_no_command_before_it_is_nothing() {
        let store = shell_pane();
        // The first prompt, after startup files that failed; an empty Enter.
        assert!(shell(&store, "\x1b]7770;command_end;1\x07\x1b]7770;cwd;/x\x07", 1).is_empty());
        assert_eq!(store.view("p").unwrap().state, DotState::Idle);
    }

    #[test]
    fn a_typed_agent_enters_agent_mode_and_its_end_leaves_it() {
        let store = shell_pane();
        let u = shell(&store, "\x1b]7770;command_start;npx vibe --x\x07", 1);
        assert!(matches!(u[0].change.as_ref().unwrap().cause, StatusEvent::AgentDetected));
        let v = store.view("p").unwrap();
        assert_eq!((v.mode, v.shell_command_running), (Mode::Agent, false));
        assert_eq!(store.titles.get("p").unwrap().agent.as_deref(), Some("vibe"));
        shell(&store, "\x1b]7770;command_end;0\x07", 2);
        assert_eq!(store.view("p").unwrap().mode, Mode::Shell);
        assert_eq!(store.titles.get("p").unwrap().agent, None);
        // The Agent's end is not a shell command's: the next prompt is nothing.
        assert!(shell(&store, "\x1b]7770;command_end;1\x07", 3).is_empty());
    }

    #[test]
    fn an_answer_names_the_latest_change_rust_made_itself() {
        let store = vibe_pane();
        let config = StatusConfig::default();
        let w = crate::event_sink::ClientId::from("w");
        let own = store.title_changed("p", ">> Vibe", 1, &config).update.unwrap();
        assert!(own.host_cause.is_none());
        let answer = store
            .run_op(&w, StatusOp::Apply { pty_id: "p".into(), event: StatusEvent::AgentExited }, &config)
            .unwrap();
        assert_eq!(answer.host_seq, Some(own.seq));
        assert!(matches!(answer.host_cause, Some(StatusEvent::Title { .. })));
    }

    #[test]
    fn a_vibe_title_drives_the_status() {
        let store = vibe_pane();
        let config = StatusConfig::default();
        assert!(store.title_changed("p", "Vibe", 1, &config).update.is_none());
        assert!(!store.title_status_seen("p"));
        let o = store.title_changed("p", ">> Vibe", 2, &config);
        assert!(store.title_status_seen("p"));
        assert_eq!(o.update.unwrap().view.unwrap().state, DotState::Working);
        let o = store.title_changed("p", "? Vibe", 3, &config);
        assert_eq!(o.update.unwrap().view.unwrap().state, DotState::Waiting);
        // Bare again: wait for the hook, then call it a cancel.
        let o = store.title_changed("p", "Vibe", 4, &config);
        let grace = o.grace.unwrap();
        let u = store.title_grace_ended("p", grace, 5, &config).unwrap();
        assert_eq!(u.view.unwrap().state, DotState::Idle);
    }

    #[test]
    fn a_later_title_cancels_the_grace_window() {
        let store = vibe_pane();
        let config = StatusConfig::default();
        store.title_changed("p", ">> Vibe", 1, &config);
        let grace = store.title_changed("p", "Vibe", 2, &config).grace.unwrap();
        store.title_changed("p", ">> Vibe", 3, &config);
        assert!(store.title_grace_ended("p", grace, 4, &config).is_none());
        assert_eq!(store.view("p").unwrap().state, DotState::Working);
    }

    #[test]
    fn titles_count_only_in_agent_mode_and_start_afresh_with_a_new_session() {
        let store = vibe_pane();
        let config = StatusConfig::default();
        store.title_changed("p", ">> Vibe", 1, &config);
        store.apply_from_host("p", StatusEvent::AgentExited, &config);
        assert!(!store.title_status_seen("p"));
        assert!(store.title_changed("p", ">> Vibe", 2, &config).update.is_none());
        let shell = StatusStore::new();
        shell.set_agent("p", Some("vibe".into()));
        assert!(shell.title_changed("p", ">> Vibe", 1, &config).update.is_none());
    }

    #[test]
    fn shadow_reads_the_frontend_json() {
        let ops: Vec<ShadowOp> = serde_json::from_str(
            r#"[{"op":"init","ptyId":"p","mode":"agent","expected":null},
                {"op":"apply","ptyId":"p","event":{"kind":"hook","transition":"working","now":5},"threshold":1024,"expected":null},
                {"op":"tick","now":9,"expected":{}},
                {"op":"remove","ptyId":"p"}]"#,
        )
        .unwrap();
        assert_eq!(ops.len(), 4);
    }

    /// Phase 9: a pane two Windows show (two apps on one Host) tells both;
    /// one going leaves the other, and the last one going forgets the pane.
    #[test]
    fn every_window_showing_a_pane_hears_its_status() {
        use crate::event_sink::ClientId;
        let store = StatusStore::new();
        let config = StatusConfig::default();
        let (a, b) = (ClientId::from("laptop"), ClientId::from("desk"));
        store.run_op(&a, StatusOp::Init { pty_id: "p".into(), mode: Some(Mode::Shell) }, &config);
        // The desk attaches to the running pane: it hears its status now
        // (and again after a reload of its Window).
        assert!(store.run_op(&b, StatusOp::Init { pty_id: "p".into(), mode: None }, &config).is_some());
        assert!(store.run_op(&b, StatusOp::Init { pty_id: "p".into(), mode: None }, &config).is_some());
        assert_eq!(store.watchers("p"), vec![a.clone(), b.clone()]);
        assert_eq!(store.owner("p"), Some(a.clone()));
        let to: Vec<String> = store.exit_update("p", Some(1), &config).into_iter().map(|(c, _)| c.0).collect();
        assert_eq!(to, ["laptop", "desk"]);
        // The laptop app goes: the desk still hears, and is the owner now.
        store.release_client("laptop");
        assert_eq!(store.watchers("p"), vec![b.clone()]);
        assert_eq!(store.owner("p"), Some(b));
        // The desk's Window closes: nobody shows it, so it is forgotten.
        store.forget_client("desk");
        assert!(store.view("p").is_none());
    }
}

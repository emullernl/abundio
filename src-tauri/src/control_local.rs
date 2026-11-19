//! Agent control calls Rust answers itself (docs/plans/remote-hosts.md
//! phase 5), instead of asking the Window that owns the Workspace: it has the
//! layouts (`layout_store.rs`, saved through to the database), every PTY's
//! status (`status_store.rs`) and screen (`screen.rs`), and the facts only
//! the Window sees, mirrored (`pane_facts.rs`).
//!
//! A port of the Window's `describe.ts`, `resolveTarget.ts`, `settle.ts` and
//! `waitForPane.ts`, whose tests it carries over. What the user sees of a
//! call (the **Control badge**, the Orchestrator graph's line) is still
//! drawn by the Window: Rust sends it `agent-control-effect`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agent_control::{handle_key, Caller, Request, Target, Until};
use crate::error::AbundioError;
use crate::pane_facts::PaneFacts;
use crate::status_machine::{DotState, Mode};
use crate::status_store::StoreView;
use crate::workspace_store::{Tab, WorkspaceWithTabs};

/// An answer the Agent sees as an error (`ControlError` in the Window).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtlError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> CtlError {
    CtlError { code, message: message.into() }
}

impl From<AbundioError> for CtlError {
    fn from(e: AbundioError) -> Self {
        err("internal", e.to_string())
    }
}

/// What Rust reads to answer a call. The app's is [`AppLive`]; tests use a
/// stand-in.
pub trait Live {
    fn workspaces(&self, profile_of: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError>;
    fn pane_numbers(&self, workspace_id: &str, pane_ids: &[String]) -> Result<Vec<(String, u32)>, AbundioError>;
    fn view(&self, pty_id: &str) -> Option<StoreView>;
    fn is_live(&self, pty_id: &str) -> bool;
    fn facts(&self, pane_id: &str) -> PaneFacts;
    fn read_screen(&self, pty_id: &str, visible: bool, lines: Option<usize>) -> Result<Vec<String>, AbundioError>;
}

/// What the user sees of a call, drawn by the owning Window.
pub trait Effects {
    /// A call from `caller_pane` at `target_pane` began: the target's
    /// Control badge (`by` names the caller) and the graph's line (`kind`
    /// is `read` or `act`). Returns an id for [`Effects::end`].
    fn begin(&self, caller_pane: &str, target_pane: &str, by: &str, kind: &str) -> String;
    fn end(&self, id: &str);
}

// ── The Workspace's panes (resolveTarget.ts) ──

/// One terminal pane of a Workspace, with the Tab it sits in.
#[derive(Debug, Clone)]
pub struct Pane {
    pub node: Value,
    pub tab_id: String,
    pub tab_name: String,
}

impl Pane {
    pub fn id(&self) -> &str {
        self.node["id"].as_str().unwrap_or("")
    }
    fn str(&self, k: &str) -> Option<&str> {
        self.node.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    pub fn pty_id(&self) -> Option<&str> {
        self.str("ptyId")
    }
}

fn terminal_nodes(tree: &Value, out: &mut Vec<Value>) {
    match tree.get("type").and_then(Value::as_str) {
        Some("terminal") => out.push(tree.clone()),
        Some("split") => {
            for side in ["first", "second"] {
                if let Some(c) = tree.get(side) {
                    terminal_nodes(c, out);
                }
            }
        }
        _ => {}
    }
}

/// Every terminal pane of a Workspace, Tab by Tab in Tab order, each Tab's
/// panes in tree order (the order new Pane numbers are claimed in).
pub fn workspace_panes(tabs: &[Tab]) -> Vec<Pane> {
    let mut sorted: Vec<&Tab> = tabs.iter().collect();
    sorted.sort_by_key(|t| t.position);
    let mut out = Vec::new();
    for tab in sorted {
        let Ok(tree) = serde_json::from_str::<Value>(&tab.layout_json) else { continue };
        let mut nodes = Vec::new();
        terminal_nodes(&tree, &mut nodes);
        for node in nodes {
            out.push(Pane { node, tab_id: tab.id.clone(), tab_name: tab.name.clone() });
        }
    }
    out
}

/// The pane a target names. A number whose pane has closed is not found:
/// numbers are never reused.
pub fn resolve_target<'a>(
    target: &Target,
    panes: &'a [Pane],
    numbers: &HashMap<String, u32>,
) -> Result<&'a Pane, CtlError> {
    match target {
        Target::Pane(n) => panes.iter().find(|p| numbers.get(p.id()) == Some(n)).ok_or_else(|| {
            err(
                "not_found",
                format!("no pane p{n} in this Workspace (it may have closed); run `abundio pane list`"),
            )
        }),
        Target::Handle(h) => {
            let key = handle_key(h);
            panes
                .iter()
                .find(|p| p.str("agentHandle").is_some_and(|a| handle_key(a) == key))
                .ok_or_else(|| {
                    err(
                        "not_found",
                        format!("no Agent named \"{h}\" in this Workspace; run `abundio agent list`"),
                    )
                })
        }
    }
}

// ── Describing a pane (describe.ts) ──

/// What Rust knows about one pane's PTY right now.
#[derive(Debug, Clone, Default)]
pub struct LiveFacts {
    pub state: Option<DotState>,
    pub mode: Option<Mode>,
    pub exited: bool,
    pub facts: PaneFacts,
}

pub fn live_facts(live: &dyn Live, pane: &Pane) -> LiveFacts {
    let view = pane.pty_id().and_then(|p| live.view(p));
    LiveFacts {
        state: view.as_ref().map(|v| v.state),
        mode: view.as_ref().map(|v| v.mode),
        exited: pane.pty_id().is_some_and(|p| !live.is_live(p)),
        facts: live.facts(pane.id()),
    }
}

pub fn control_status(f: &LiveFacts) -> &'static str {
    if f.exited {
        return "exited";
    }
    match f.state {
        Some(DotState::Working) => "working",
        Some(DotState::Waiting) => "waiting",
        Some(DotState::Ready) => "ready",
        Some(DotState::Error) => "error",
        _ => "idle",
    }
}

pub fn pane_label(n: u32) -> String {
    format!("p{n}")
}

/// One pane as `abundio pane list` / `pane current` print it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneDescription {
    pub pane: String,
    pub number: u32,
    pub handle: Option<String>,
    pub tab: String,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub mode: &'static str,
    pub agent: Option<String>,
    pub status: &'static str,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub command: Option<String>,
    pub spawned_by: Option<String>,
    pub progress: Option<String>,
}

/// One Agent as `abundio agent list` prints it.
pub fn describe_agent(p: &PaneDescription) -> Value {
    json!({
        "pane": p.pane, "number": p.number, "handle": p.handle, "tab": p.tab,
        "self": p.is_self, "agent": p.agent, "status": p.status, "cwd": p.cwd,
        "title": p.title, "spawnedBy": p.spawned_by, "progress": p.progress,
    })
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.clone().filter(|s| !s.is_empty())
}

pub fn describe_pane(scope: &Scope, pane: &Pane, f: &LiveFacts) -> PaneDescription {
    let number = scope.numbers.get(pane.id()).copied().unwrap_or(0);
    let agent_mode = f.mode == Some(Mode::Agent);
    let spawned_by = pane.str("spawnedBy").and_then(|owner| match scope.numbers.get(owner) {
        Some(n) => Some(pane_label(*n)),
        None => scope.owners_elsewhere.get(owner).cloned(),
    });
    PaneDescription {
        pane: pane_label(number),
        number,
        handle: pane.str("agentHandle").map(str::to_string),
        tab: pane.tab_name.clone(),
        is_self: pane.id() == scope.caller.pane_id,
        mode: if agent_mode { "agent" } else { "shell" },
        agent: if agent_mode {
            pane.str("agentId").map(str::to_string).or_else(|| non_empty(&f.facts.detected_agent_id))
        } else {
            None
        },
        status: control_status(f),
        cwd: non_empty(&f.facts.cwd).or_else(|| pane.str("cwd").map(str::to_string)),
        title: non_empty(&f.facts.title),
        command: if agent_mode { None } else { non_empty(&f.facts.command) },
        spawned_by,
        progress: if agent_mode { f.facts.progress.clone() } else { None },
    }
}

// ── The scope of a call ──

/// A call's Workspace as Rust sees it.
pub struct Scope {
    pub caller: Caller,
    pub workspace_id: String,
    pub home: bool,
    pub panes: Vec<Pane>,
    pub numbers: HashMap<String, u32>,
    /// Owners of this Workspace's Spawned panes that sit in another
    /// Workspace: pane id → `p2 · api`.
    pub owners_elsewhere: HashMap<String, String>,
    /// The caller as the Control badge names it.
    pub caller_name: String,
}

fn find_pane_workspace<'a>(all: &'a [WorkspaceWithTabs], pane_id: &str) -> Option<&'a WorkspaceWithTabs> {
    all.iter().find(|w| workspace_panes(&w.tabs).iter().any(|p| p.id() == pane_id))
}

pub fn load_scope(live: &dyn Live, caller: &Caller, workspace_id: &str) -> Result<Scope, CtlError> {
    let all = live.workspaces(&caller.workspace_id)?;
    let home = workspace_id == caller.workspace_id;
    let ws = all.iter().find(|w| w.workspace.id == workspace_id).ok_or_else(|| {
        err(
            "not_found",
            if home { "your Workspace is gone" } else { "that Workspace is gone" },
        )
    })?;
    let panes = workspace_panes(&ws.tabs);
    let ids: Vec<String> = panes.iter().map(|p| p.id().to_string()).collect();
    let numbers: HashMap<String, u32> = live.pane_numbers(workspace_id, &ids)?.into_iter().collect();
    let mut owners_elsewhere = HashMap::new();
    for p in &panes {
        let Some(owner) = p.str("spawnedBy") else { continue };
        if numbers.contains_key(owner) || owners_elsewhere.contains_key(owner) {
            continue;
        }
        if let Some(other) = find_pane_workspace(&all, owner) {
            let n = live
                .pane_numbers(&other.workspace.id, &[owner.to_string()])?
                .first()
                .map(|(_, n)| *n)
                .unwrap_or(0);
            owners_elsewhere.insert(owner.to_string(), format!("{} · {}", pane_label(n), other.workspace.name));
        }
    }
    let caller_home = all.iter().find(|w| w.workspace.id == caller.workspace_id);
    let own_handle = caller_home.and_then(|w| {
        workspace_panes(&w.tabs)
            .into_iter()
            .find(|p| p.id() == caller.pane_id)
            .and_then(|p| p.str("agentHandle").map(str::to_string))
    });
    let name = match own_handle {
        Some(h) => h,
        None => {
            let n = live
                .pane_numbers(&caller.workspace_id, std::slice::from_ref(&caller.pane_id))?
                .first()
                .map(|(_, n)| *n)
                .unwrap_or(0);
            if n == 0 { "an Agent".to_string() } else { pane_label(n) }
        }
    };
    let caller_name = match caller_home {
        Some(h) if !home => format!("{name} · {}", h.workspace.name),
        _ => name,
    };
    Ok(Scope {
        caller: caller.clone(),
        workspace_id: workspace_id.to_string(),
        home,
        panes,
        numbers,
        owners_elsewhere,
        caller_name,
    })
}

// ── Waiting (settle.ts) ──

/// How long a prompted Agent has to start Working before the wait gives up.
pub const STALL: Duration = Duration::from_millis(5000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitEnd {
    Ready,
    Waiting,
    Error,
    Left,
}

impl WaitEnd {
    fn status(self) -> &'static str {
        match self {
            WaitEnd::Ready => "ready",
            WaitEnd::Waiting => "waiting",
            WaitEnd::Error => "error",
            WaitEnd::Left => "exited",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaitGoal {
    pub until: Until,
    /// After a prompt: only a state reached after Working counts.
    pub need_working: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WaitProgress {
    pub saw_working: bool,
    pub end: Option<WaitEnd>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snap {
    pub state: Option<DotState>,
    pub mode: Option<Mode>,
    /// The PTY has exited, or the pane has closed.
    pub gone: bool,
}

fn matches(until: Until, state: Option<DotState>) -> Option<WaitEnd> {
    let end = match state? {
        DotState::Ready => WaitEnd::Ready,
        DotState::Waiting => WaitEnd::Waiting,
        DotState::Error => WaitEnd::Error,
        _ => return None,
    };
    let hit = match until {
        Until::Settled => true,
        Until::Ready => end == WaitEnd::Ready,
        Until::Waiting => end == WaitEnd::Waiting,
        Until::Error => end == WaitEnd::Error,
    };
    hit.then_some(end)
}

/// Feed one snapshot to a wait. Call it with the snapshot at the start too.
pub fn wait_step(goal: WaitGoal, progress: WaitProgress, snap: Snap) -> WaitProgress {
    if progress.end.is_some() {
        return progress;
    }
    if snap.gone || snap.mode != Some(Mode::Agent) {
        return WaitProgress { saw_working: progress.saw_working, end: Some(WaitEnd::Left) };
    }
    let saw_working = progress.saw_working || snap.state == Some(DotState::Working);
    if goal.need_working && !saw_working {
        return WaitProgress { saw_working, end: None };
    }
    WaitProgress { saw_working, end: matches(goal.until, snap.state) }
}

pub fn is_stalled(goal: WaitGoal, progress: WaitProgress, elapsed: Duration) -> bool {
    goal.need_working && !progress.saw_working && progress.end.is_none() && elapsed >= STALL
}

/// The pane's state now, read afresh: it may have closed or moved Tab.
fn snap(live: &dyn Live, caller: &Caller, workspace_id: &str, pane_id: &str) -> Snap {
    let pane = live
        .workspaces(&caller.workspace_id)
        .ok()
        .and_then(|all| {
            all.into_iter()
                .find(|w| w.workspace.id == workspace_id)
                .and_then(|w| workspace_panes(&w.tabs).into_iter().find(|p| p.id() == pane_id))
        });
    let Some(pane) = pane else {
        return Snap { state: None, mode: None, gone: true };
    };
    let Some(pty) = pane.pty_id() else {
        return Snap { state: None, mode: None, gone: true };
    };
    let view = live.view(pty);
    Snap {
        state: view.as_ref().map(|v| v.state),
        mode: view.as_ref().map(|v| v.mode),
        gone: !live.is_live(pty),
    }
}

/// How often a wait looks again. The Window watched pushed changes plus a
/// 250 ms poll; this polls Rust's own store, which is cheap.
const POLL: Duration = Duration::from_millis(100);

/// Why a wait ended without an answer about the pane.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitStop {
    Cancelled,
    TimedOut,
}

/// Wait until the pane reaches `goal`. `cancel` ends it when it receives
/// anything; `limit` is the call's timeout (`None`: none).
pub fn wait_for_pane(
    live: &dyn Live,
    caller: &Caller,
    workspace_id: &str,
    pane_id: &str,
    goal: WaitGoal,
    cancel: &Receiver<Value>,
    limit: Option<Duration>,
) -> Result<Result<(WaitEnd, Duration), CtlError>, WaitStop> {
    let started = Instant::now();
    let mut progress = WaitProgress::default();
    loop {
        progress = wait_step(goal, progress, snap(live, caller, workspace_id, pane_id));
        let waited = started.elapsed();
        if let Some(end) = progress.end {
            return Ok(Ok((end, waited)));
        }
        if is_stalled(goal, progress, waited) {
            return Ok(Err(err(
                "stalled",
                "the prompt was sent, but the Agent did not start working within 5 seconds; read the pane to see what happened before sending it again",
            )));
        }
        let slice = match limit {
            Some(l) => match l.checked_sub(waited) {
                Some(left) if !left.is_zero() => left.min(POLL),
                _ => return Err(WaitStop::TimedOut),
            },
            None => POLL,
        };
        match cancel.recv_timeout(slice) {
            Ok(_) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                return Err(WaitStop::Cancelled)
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
        }
    }
}

// ── The calls ──

/// Whether Rust answers `request` itself.
pub fn handles(request: &Request) -> bool {
    matches!(
        request,
        Request::PaneList
            | Request::PaneCurrent
            | Request::AgentList
            | Request::PaneRead { .. }
            | Request::AgentWait { .. }
    )
}

fn require_agent(f: &LiveFacts) -> Result<(), CtlError> {
    if f.exited || f.mode != Some(Mode::Agent) {
        return Err(err(
            "not_an_agent",
            "that pane is not running an Agent; use `abundio pane run` for a shell",
        ));
    }
    Ok(())
}

/// Run `f` with the target's Control badge and graph line up, as the
/// Window's `withBadge` and `noteActivity` did. A pane acting on itself
/// shows neither.
fn with_effects<T>(
    effects: &dyn Effects,
    scope: &Scope,
    pane: &Pane,
    kind: &str,
    f: impl FnOnce() -> T,
) -> T {
    if pane.id() == scope.caller.pane_id {
        return f();
    }
    let id = effects.begin(&scope.caller.pane_id, pane.id(), &scope.caller_name, kind);
    let out = f();
    effects.end(&id);
    out
}

/// The pane a target names, for a wait's cycle check before it starts.
pub fn resolve(live: &dyn Live, caller: &Caller, workspace_id: &str, target: &Target) -> Result<String, CtlError> {
    let scope = load_scope(live, caller, workspace_id)?;
    Ok(resolve_target(target, &scope.panes, &scope.numbers)?.id().to_string())
}

/// Answer one call Rust handles (see [`handles`]). `cancel` and `limit`
/// matter only to a wait.
pub fn run(
    live: &dyn Live,
    effects: &dyn Effects,
    caller: &Caller,
    workspace_id: &str,
    request: &Request,
    cancel: &Receiver<Value>,
    limit: Option<Duration>,
) -> Result<Result<Value, CtlError>, WaitStop> {
    let scope = match load_scope(live, caller, workspace_id) {
        Ok(s) => s,
        Err(e) => return Ok(Err(e)),
    };
    let describe = |p: &Pane| describe_pane(&scope, p, &live_facts(live, p));
    Ok(Ok(match request {
        Request::PaneList => {
            json!({ "panes": scope.panes.iter().map(describe).collect::<Vec<_>>() })
        }
        Request::AgentList => json!({
            "agents": scope.panes.iter().map(describe)
                .filter(|d| d.mode == "agent").map(|d| describe_agent(&d)).collect::<Vec<_>>()
        }),
        Request::PaneCurrent => {
            // Always the caller's own pane, whatever --workspace says.
            let own = if scope.home {
                None
            } else {
                match load_scope(live, caller, &caller.workspace_id) {
                    Ok(s) => Some(s),
                    Err(e) => return Ok(Err(e)),
                }
            };
            let own = own.as_ref().unwrap_or(&scope);
            let Some(pane) = own.panes.iter().find(|p| p.id() == caller.pane_id) else {
                return Ok(Err(err("not_found", "your pane is no longer open")));
            };
            serde_json::to_value(describe_pane(own, pane, &live_facts(live, pane))).unwrap_or(Value::Null)
        }
        Request::PaneRead { target, lines, visible } => {
            let pane = match resolve_target(target, &scope.panes, &scope.numbers) {
                Ok(p) => p,
                Err(e) => return Ok(Err(e)),
            };
            let read = with_effects(effects, &scope, pane, "read", || {
                let pty = pane.pty_id().filter(|p| live.is_live(p)).ok_or_else(|| {
                    err("state_unknown", "that pane's terminal is not loaded yet; try again in a moment")
                })?;
                live.read_screen(pty, *visible, lines.map(|n| n as usize))
                    .map_err(|_| err("state_unknown", "that pane's terminal is not loaded yet; try again in a moment"))
            });
            match read {
                Ok(text) => json!({
                    "pane": pane_label(scope.numbers.get(pane.id()).copied().unwrap_or(0)),
                    "lines": text.len(),
                    "text": text.join("\n"),
                }),
                Err(e) => return Ok(Err(e)),
            }
        }
        Request::AgentWait { target, until, .. } => {
            let pane = match resolve_target(target, &scope.panes, &scope.numbers) {
                Ok(p) => p,
                Err(e) => return Ok(Err(e)),
            };
            let outcome = with_effects(effects, &scope, pane, "read", || {
                require_agent(&live_facts(live, pane))?;
                let goal = WaitGoal { until: *until, need_working: false };
                match wait_for_pane(live, caller, workspace_id, pane.id(), goal, cancel, limit) {
                    Ok(r) => r.map(Ok),
                    Err(stop) => Ok(Err(stop)),
                }
            });
            let (end, waited) = match outcome {
                Ok(Ok(v)) => v,
                Ok(Err(stop)) => return Err(stop),
                Err(e) => return Ok(Err(e)),
            };
            // The description as it is now that the wait is over.
            let after = match load_scope(live, caller, workspace_id) {
                Ok(s) => s,
                Err(e) => return Ok(Err(e)),
            };
            let now = after.panes.iter().find(|p| p.id() == pane.id()).unwrap_or(pane);
            let mut v = describe_agent(&describe_pane(&after, now, &live_facts(live, now)));
            v["status"] = json!(end.status());
            v["waitedMs"] = json!(waited.as_millis() as u64);
            v
        }
        _ => return Ok(Err(err("internal", "not a call Rust answers"))),
    }))
}

// ── The app's live state ──

pub struct AppLive<'a> {
    pub store: &'a crate::workspace_store::WorkspaceStore,
    pub ptys: &'a crate::pty_manager::PtyManager,
    pub status: &'a crate::status_store::StatusStore,
    pub facts: &'a crate::pane_facts::PaneFactsStore,
}

impl Live for AppLive<'_> {
    fn workspaces(&self, caller_workspace: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let Some(profile) = self.store.profile_of(caller_workspace)? else {
            return Ok(Vec::new());
        };
        self.store.list(&profile)
    }
    fn pane_numbers(&self, workspace_id: &str, pane_ids: &[String]) -> Result<Vec<(String, u32)>, AbundioError> {
        self.store.pane_numbers(workspace_id, pane_ids)
    }
    fn view(&self, pty_id: &str) -> Option<StoreView> {
        self.status.view(pty_id)
    }
    fn is_live(&self, pty_id: &str) -> bool {
        self.ptys.is_live(pty_id)
    }
    fn facts(&self, pane_id: &str) -> PaneFacts {
        self.facts.get(pane_id)
    }
    fn read_screen(&self, pty_id: &str, visible: bool, lines: Option<usize>) -> Result<Vec<String>, AbundioError> {
        self.ptys.read_screen(pty_id, visible, lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_store::WorkspaceStore;
    use std::collections::HashSet;
    use std::sync::Mutex;

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    #[derive(Default)]
    struct Fake {
        store: Option<WorkspaceStore>,
        views: Mutex<HashMap<String, StoreView>>,
        live: Mutex<HashSet<String>>,
        facts: HashMap<String, PaneFacts>,
        screens: HashMap<String, Vec<String>>,
    }

    impl Live for Fake {
        fn workspaces(&self, caller_ws: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
            let s = self.store.as_ref().unwrap();
            let profile = s.profile_of(caller_ws)?.unwrap_or_else(|| PID.to_string());
            s.list(&profile)
        }
        fn pane_numbers(&self, ws: &str, ids: &[String]) -> Result<Vec<(String, u32)>, AbundioError> {
            self.store.as_ref().unwrap().pane_numbers(ws, ids)
        }
        fn view(&self, pty: &str) -> Option<StoreView> {
            self.views.lock().unwrap().get(pty).cloned()
        }
        fn is_live(&self, pty: &str) -> bool {
            self.live.lock().unwrap().contains(pty)
        }
        fn facts(&self, pane: &str) -> PaneFacts {
            self.facts.get(pane).cloned().unwrap_or_default()
        }
        fn read_screen(&self, pty: &str, _visible: bool, lines: Option<usize>) -> Result<Vec<String>, AbundioError> {
            let all = self.screens.get(pty).cloned().unwrap_or_default();
            Ok(match lines {
                Some(n) => all[all.len().saturating_sub(n)..].to_vec(),
                None => all,
            })
        }
    }

    #[derive(Default)]
    struct Recorded(Mutex<Vec<String>>);
    impl Effects for Recorded {
        fn begin(&self, caller: &str, target: &str, by: &str, kind: &str) -> String {
            self.0.lock().unwrap().push(format!("begin {caller}->{target} by {by} ({kind})"));
            "e1".into()
        }
        fn end(&self, id: &str) {
            self.0.lock().unwrap().push(format!("end {id}"));
        }
    }

    fn view(state: DotState, mode: Mode) -> StoreView {
        StoreView {
            state,
            mode,
            hook_driven: false,
            shell_command_running: false,
            working_since: None,
            last_activity_at: None,
            active_subagents: vec![],
            stop_held_for_subagents: false,
            pre_error_state: None,
            title_held: false,
        }
    }

    fn term(id: &str, pty: &str, extra: Value) -> Value {
        let mut n = json!({ "type": "terminal", "id": id, "ptyId": pty });
        if let Value::Object(m) = extra {
            for (k, v) in m {
                n[k] = v;
            }
        }
        n
    }

    fn split(a: Value, b: Value) -> Value {
        json!({ "type": "split", "id": format!("s-{}", a["id"].as_str().unwrap()), "direction": "vertical", "ratio": 0.5, "first": a, "second": b })
    }

    /// A Workspace "w" with one Tab: shell `sh` (p1), Agent `ag` (p2,
    /// "Reviewer", spawned by `sh`).
    fn world() -> (Fake, String, Caller) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let store = WorkspaceStore::new(conn);
        let ws = store.create("w", "/tmp", PID).unwrap();
        let layout = split(
            term("sh", "pty-sh", json!({})),
            term("ag", "pty-ag", json!({ "agentId": "claude", "agentHandle": "Reviewer", "spawnedBy": "sh" })),
        );
        store.set_tab_layout(&ws.tabs[0].id, &layout.to_string()).unwrap();
        let id = ws.workspace.id.clone();
        let fake = Fake { store: Some(store), ..Default::default() };
        fake.views.lock().unwrap().insert("pty-sh".into(), view(DotState::Idle, Mode::Shell));
        fake.views.lock().unwrap().insert("pty-ag".into(), view(DotState::Ready, Mode::Agent));
        fake.live.lock().unwrap().extend(["pty-sh".to_string(), "pty-ag".to_string()]);
        let caller = Caller {
            pty_id: "pty-sh".into(),
            pane_id: "sh".into(),
            workspace_id: id.clone(),
            window_label: "main".into(),
        };
        (fake, id, caller)
    }

    fn never() -> Receiver<Value> {
        crossbeam_channel::never()
    }

    fn ok(r: Result<Result<Value, CtlError>, WaitStop>) -> Value {
        r.expect("not stopped").expect("an answer")
    }

    fn tab(id: &str, name: &str, position: i32, layout: &str) -> Tab {
        Tab {
            id: id.into(),
            workspace_id: "w".into(),
            name: name.into(),
            layout_json: layout.into(),
            position,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn lists_terminals_tab_by_tab_in_tree_order_skipping_files_and_bad_layouts() {
        let two = split(term("b", "", json!({})), json!({ "type": "file", "id": "f", "filePath": "/x" }));
        let tabs = vec![
            tab("t2", "Two", 1, &two.to_string()),
            tab("t1", "One", 0, &term("a", "", json!({})).to_string()),
            tab("t3", "Bad", 2, "{not json"),
        ];
        let ids: Vec<_> = workspace_panes(&tabs).iter().map(|p| (p.id().to_string(), p.tab_name.clone())).collect();
        assert_eq!(ids, vec![("a".into(), "One".into()), ("b".into(), "Two".into())]);
    }

    #[test]
    fn resolves_by_number_and_by_handle_whatever_its_spacing() {
        let (fake, ws, caller) = world();
        let scope = load_scope(&fake, &caller, &ws).unwrap();
        assert_eq!(resolve_target(&Target::Pane(2), &scope.panes, &scope.numbers).unwrap().id(), "ag");
        assert_eq!(
            resolve_target(&Target::Handle("  REVIEWER ".into()), &scope.panes, &scope.numbers).unwrap().id(),
            "ag"
        );
        let miss = resolve_target(&Target::Pane(9), &scope.panes, &scope.numbers).unwrap_err();
        assert_eq!(miss.code, "not_found");
        assert!(miss.message.contains("p9"));
        assert_eq!(
            resolve_target(&Target::Handle("nobody".into()), &scope.panes, &scope.numbers).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn a_closed_panes_number_is_not_found_or_reused() {
        let (fake, ws, caller) = world();
        load_scope(&fake, &caller, &ws).unwrap();
        let store = fake.store.as_ref().unwrap();
        let tab = &store.list(PID).unwrap().into_iter().find(|w| w.workspace.id == ws).unwrap().tabs[0];
        store.set_tab_layout(&tab.id, &split(term("ag", "pty-ag", json!({})), term("new", "", json!({}))).to_string()).unwrap();
        let scope = load_scope(&fake, &caller, &ws).unwrap();
        assert!(resolve_target(&Target::Pane(1), &scope.panes, &scope.numbers).is_err());
        assert_eq!(scope.numbers["new"], 3);
    }

    #[test]
    fn describes_a_shell_and_an_agent_with_its_owner_by_number() {
        let (mut fake, ws, caller) = world();
        fake.facts.insert(
            "sh".into(),
            PaneFacts { title: Some("zsh".into()), cwd: Some("/live".into()), command: Some("make".into()), ..Default::default() },
        );
        fake.facts.insert("ag".into(), PaneFacts { progress: Some("tests".into()), command: Some("x".into()), ..Default::default() });
        let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &Request::PaneList, &never(), None));
        assert_eq!(
            v["panes"][0],
            json!({ "pane": "p1", "number": 1, "handle": null, "tab": "Tab 1", "self": true, "mode": "shell",
                    "agent": null, "status": "idle", "cwd": "/live", "title": "zsh", "command": "make",
                    "spawnedBy": null, "progress": null })
        );
        assert_eq!(
            v["panes"][1],
            json!({ "pane": "p2", "number": 2, "handle": "Reviewer", "tab": "Tab 1", "self": false, "mode": "agent",
                    "agent": "claude", "status": "ready", "cwd": null, "title": null, "command": null,
                    "spawnedBy": "p1", "progress": "tests" })
        );
    }

    #[test]
    fn falls_back_to_the_detected_agent_and_the_layouts_folder() {
        let (mut fake, ws, caller) = world();
        let store = fake.store.as_ref().unwrap();
        let tab = store.list(PID).unwrap().into_iter().find(|w| w.workspace.id == ws).unwrap().tabs[0].clone();
        store.set_tab_layout(&tab.id, &term("ag", "pty-ag", json!({ "cwd": "/saved" })).to_string()).unwrap();
        fake.facts.insert("ag".into(), PaneFacts { detected_agent_id: Some("codex".into()), ..Default::default() });
        let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &Request::AgentList, &never(), None));
        assert_eq!(v["agents"][0]["agent"], "codex");
        assert_eq!(v["agents"][0]["cwd"], "/saved");
    }

    #[test]
    fn uses_the_glossarys_words_and_exited_wins() {
        let f = |state, exited| LiveFacts { state, exited, ..Default::default() };
        assert_eq!(control_status(&f(Some(DotState::Working), false)), "working");
        assert_eq!(control_status(&f(Some(DotState::Waiting), false)), "waiting");
        assert_eq!(control_status(&f(None, false)), "idle");
        assert_eq!(control_status(&f(Some(DotState::Working), true)), "exited");
    }

    #[test]
    fn lists_only_agent_mode_panes_as_agents() {
        let (fake, ws, caller) = world();
        let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &Request::AgentList, &never(), None));
        let agents = v["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["handle"], "Reviewer");
        assert!(agents[0].get("mode").is_none());
    }

    #[test]
    fn reads_a_pane_from_rusts_screen_with_the_badge_up_meanwhile() {
        let (mut fake, ws, caller) = world();
        fake.screens.insert("pty-ag".into(), vec!["one".into(), "two".into(), "three".into()]);
        let effects = Recorded::default();
        let req = Request::PaneRead { target: Target::Handle("reviewer".into()), lines: Some(2), visible: false };
        let v = ok(run(&fake, &effects, &caller, &ws, &req, &never(), None));
        assert_eq!(v, json!({ "pane": "p2", "lines": 2, "text": "two\nthree" }));
        assert_eq!(*effects.0.lock().unwrap(), vec!["begin sh->ag by p1 (read)", "end e1"]);
    }

    #[test]
    fn a_pane_reading_itself_shows_no_badge() {
        let (fake, ws, caller) = world();
        let effects = Recorded::default();
        let req = Request::PaneRead { target: Target::Pane(1), lines: None, visible: true };
        ok(run(&fake, &effects, &caller, &ws, &req, &never(), None));
        assert!(effects.0.lock().unwrap().is_empty());
    }

    #[test]
    fn refuses_to_read_a_terminal_that_is_not_running() {
        let (fake, ws, caller) = world();
        fake.live.lock().unwrap().remove("pty-ag");
        let req = Request::PaneRead { target: Target::Pane(2), lines: None, visible: false };
        let e = run(&fake, &Recorded::default(), &caller, &ws, &req, &never(), None).unwrap().unwrap_err();
        assert_eq!(e.code, "state_unknown");
    }

    #[test]
    fn calls_into_another_workspace_name_the_caller_with_its_own() {
        let (mut fake, home, caller) = world();
        let store = fake.store.as_ref().unwrap();
        let other = store.create("api", "/tmp/api", PID).unwrap();
        store
            .set_tab_layout(&other.tabs[0].id, &term("x", "pty-x", json!({ "agentHandle": "Builder" })).to_string())
            .unwrap();
        let other_id = other.workspace.id.clone();
        fake.views.lock().unwrap().insert("pty-x".into(), view(DotState::Working, Mode::Agent));
        fake.live.lock().unwrap().insert("pty-x".into());
        fake.screens.insert("pty-x".into(), vec!["hi".into()]);
        let effects = Recorded::default();
        let req = Request::PaneRead { target: Target::Handle("builder".into()), lines: None, visible: false };
        ok(run(&fake, &effects, &caller, &other_id, &req, &never(), None));
        assert_eq!(effects.0.lock().unwrap()[0], "begin sh->x by p1 · w (read)");
        // pane current is still the caller's own pane.
        let v = ok(run(&fake, &effects, &caller, &other_id, &Request::PaneCurrent, &never(), None));
        assert_eq!(v["pane"], "p1");
        assert_eq!(v["self"], true);
        let _ = home;
    }

    #[test]
    fn names_an_owner_in_another_workspace_by_its_number_there() {
        let (fake, home, caller) = world();
        let store = fake.store.as_ref().unwrap();
        let other = store.create("api", "/tmp/api", PID).unwrap();
        store
            .set_tab_layout(&other.tabs[0].id, &term("y", "", json!({ "spawnedBy": "ag" })).to_string())
            .unwrap();
        load_scope(&fake, &caller, &home).unwrap();
        let v = ok(run(&fake, &Recorded::default(), &caller, &other.workspace.id, &Request::PaneList, &never(), None));
        assert_eq!(v["panes"][0]["spawnedBy"], "p2 · w");
    }

    // ── settle.ts ──

    fn snap_of(state: Option<DotState>) -> Snap {
        Snap { state, mode: Some(Mode::Agent), gone: false }
    }

    fn run_steps(goal: WaitGoal, states: &[Option<DotState>]) -> Option<WaitEnd> {
        let mut p = WaitProgress::default();
        for s in states {
            p = wait_step(goal, p, snap_of(*s));
        }
        p.end
    }

    const PROMPTED: WaitGoal = WaitGoal { until: Until::Settled, need_working: true };
    const PLAIN: WaitGoal = WaitGoal { until: Until::Settled, need_working: false };

    #[test]
    fn after_a_prompt_only_a_state_reached_after_working_counts() {
        use DotState::*;
        assert_eq!(run_steps(PROMPTED, &[Some(Ready), Some(Working), Some(Ready)]), Some(WaitEnd::Ready));
        assert_eq!(run_steps(PROMPTED, &[Some(Working), Some(Waiting)]), Some(WaitEnd::Waiting));
        assert_eq!(run_steps(PROMPTED, &[Some(Working), Some(Error)]), Some(WaitEnd::Error));
        assert_eq!(run_steps(PROMPTED, &[Some(Ready), Some(Ready)]), None);
        let mut p = wait_step(PROMPTED, WaitProgress::default(), Snap { state: Some(Ready), mode: Some(Mode::Shell), gone: false });
        assert_eq!(p.end, Some(WaitEnd::Left));
        p = wait_step(PROMPTED, WaitProgress::default(), Snap { state: Some(Working), mode: Some(Mode::Agent), gone: true });
        assert_eq!(p.end, Some(WaitEnd::Left));
    }

    #[test]
    fn a_plain_wait_ends_at_once_when_settled_and_until_picks_the_state() {
        use DotState::*;
        assert_eq!(run_steps(PLAIN, &[Some(Ready)]), Some(WaitEnd::Ready));
        assert_eq!(run_steps(PLAIN, &[Some(Idle), Some(Working)]), None);
        let only_error = WaitGoal { until: Until::Error, need_working: false };
        assert_eq!(run_steps(only_error, &[Some(Ready), Some(Waiting)]), None);
        assert_eq!(run_steps(only_error, &[Some(Error)]), Some(WaitEnd::Error));
        assert!(!is_stalled(PLAIN, WaitProgress::default(), Duration::from_secs(60)));
        assert!(is_stalled(PROMPTED, WaitProgress::default(), STALL));
        let ended = WaitProgress { saw_working: true, end: Some(WaitEnd::Ready) };
        assert_eq!(wait_step(PLAIN, ended, snap_of(Some(Working))), ended);
    }

    // ── agent wait ──

    fn wait_req(timeout_ms: Option<u64>) -> Request {
        Request::AgentWait { target: Target::Pane(2), until: Until::Settled, timeout_ms }
    }

    #[test]
    fn a_wait_answers_at_once_when_already_settled() {
        let (fake, ws, caller) = world();
        let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &wait_req(None), &never(), None));
        assert_eq!(v["status"], "ready");
        assert_eq!(v["handle"], "Reviewer");
        assert!(v["waitedMs"].as_u64().unwrap() < 1000);
    }

    #[test]
    fn a_wait_follows_the_status_until_it_settles() {
        let (fake, ws, caller) = world();
        fake.views.lock().unwrap().insert("pty-ag".into(), view(DotState::Working, Mode::Agent));
        std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(250));
                fake.views.lock().unwrap().insert("pty-ag".into(), view(DotState::Waiting, Mode::Agent));
            });
            let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &wait_req(None), &never(), None));
            assert_eq!(v["status"], "waiting");
        });
    }

    #[test]
    fn a_wait_reports_exited_when_the_agent_quits() {
        let (fake, ws, caller) = world();
        fake.views.lock().unwrap().insert("pty-ag".into(), view(DotState::Working, Mode::Agent));
        std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(150));
                fake.live.lock().unwrap().remove("pty-ag");
            });
            let v = ok(run(&fake, &Recorded::default(), &caller, &ws, &wait_req(None), &never(), None));
            assert_eq!(v["status"], "exited");
        });
    }

    #[test]
    fn a_wait_stops_when_cancelled_or_out_of_time() {
        let (fake, ws, caller) = world();
        fake.views.lock().unwrap().insert("pty-ag".into(), view(DotState::Working, Mode::Agent));
        let (tx, rx) = crossbeam_channel::bounded(1);
        tx.send(json!({})).unwrap();
        assert_eq!(run(&fake, &Recorded::default(), &caller, &ws, &wait_req(None), &rx, None).unwrap_err(), WaitStop::Cancelled);
        let r = run(&fake, &Recorded::default(), &caller, &ws, &wait_req(Some(150)), &never(), Some(Duration::from_millis(150)));
        assert_eq!(r.unwrap_err(), WaitStop::TimedOut);
    }

    #[test]
    fn a_wait_on_a_shell_is_refused() {
        let (fake, ws, caller) = world();
        let req = Request::AgentWait { target: Target::Pane(1), until: Until::Settled, timeout_ms: None };
        let e = run(&fake, &Recorded::default(), &caller, &ws, &req, &never(), None).unwrap().unwrap_err();
        assert_eq!(e.code, "not_an_agent");
    }
}

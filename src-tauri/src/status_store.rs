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
//! **Shadow mode** (dev builds): the frontend mirrors each of those operations
//! here with its own result, and this store reports any difference. Once that
//! stays quiet in real use, this store becomes the authority (phase 3c).

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
        let before = hydrate(self.by_pty.get(pty_id).map(|s| s.clone()), touched);
        let after = reduce(before, event, config);
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
    }

    pub fn view(&self, pty_id: &str) -> Option<StoreView> {
        self.by_pty.get(pty_id).map(|s| StoreView::from(&*s))
    }
}

/// One mirrored operation in shadow mode, with the frontend's result.
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowMismatch {
    pub pty_id: String,
    pub op: String,
    pub frontend: Option<StoreView>,
    pub rust: Option<StoreView>,
}

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
    fn the_heuristic_fields_do_not_survive_between_events() {
        let store = StatusStore::new();
        store.init("p", Some(Mode::Agent));
        let c = StatusConfig::default();
        // The hit history starts empty on every event, so output sent through
        // the store never trips the byte heuristic: terminalManager runs that
        // itself and sends `recordOutput` (as in the frontend store).
        store.apply("p", &StatusEvent::Keystroke { key: crate::status_machine::Key::Other, esc_required: 2, now: 10_000 }, &c);
        for i in 0..5 {
            store.apply("p", &StatusEvent::Output { bytes: 2000, now: 10_001 + i }, &c);
        }
        assert_eq!(store.view("p").unwrap().state, DotState::Idle);
        store.apply("p", &StatusEvent::RecordOutput { now: 10_010 }, &c);
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
        let raw = include_str!("../../src/lib/__tests__/fixtures/statusShadowStore.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut ops_seen = 0;
        for (i, run) in doc["runs"].as_array().unwrap().iter().enumerate() {
            let ops: Vec<ShadowOp> = serde_json::from_value(run.clone())
                .unwrap_or_else(|e| panic!("run {i}: {e}"));
            ops_seen += ops.len();
            let store = StatusStore::new();
            let mismatches = store.shadow(ops);
            assert!(mismatches.is_empty(), "run {i}: {:#?}", &mismatches[..mismatches.len().min(3)]);
        }
        assert!(ops_seen > 1000, "only {ops_seen} ops");
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
}

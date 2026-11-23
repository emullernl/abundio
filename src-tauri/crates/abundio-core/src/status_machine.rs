//! The status machine in Rust (ADR-0063, docs/plans/remote-hosts.md phase 3).
//!
//! A line-for-line port of `src/lib/statusReducer.ts`: `reduce(state, event)`
//! is the single home for every transition between the Status-indicator
//! states (Idle / Working / Waiting / Ready / Error). Pure: time arrives on
//! the event, nothing else is read. The TypeScript file holds the reasoning
//! behind each rule (ADR-0009, -0015, -0022, -0026, -0027, -0047); this one
//! keeps the same function names so the two can be read side by side.
//!
//! Parity is checked by `status_parity.json`: random event sequences run
//! through the TypeScript reducer, with every state it produced. The Rust
//! test replays them and must produce the same states.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotState {
    Idle,
    Working,
    Waiting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Agent,
    Shell,
}

/// What a pane was doing before a Mid-turn failure (ADR-0026).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreError {
    Working,
    Waiting,
}

impl From<PreError> for DotState {
    fn from(p: PreError) -> Self {
        match p {
            PreError::Working => DotState::Working,
            PreError::Waiting => DotState::Waiting,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transition {
    Working,
    Waiting,
    Ready,
    Idle,
    Error,
    ErrorMidTurn,
    Resume,
    Attach,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    Esc,
    Answer,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleStatus {
    Working,
    Waiting,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusState {
    pub state: DotState,
    pub mode: Mode,
    pub hook_driven: bool,
    pub working_since: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub shell_command_running: bool,
    pub bytes_since_idle: i64,
    pub threshold_hit_times: Vec<i64>,
    pub last_input_at: i64,
    pub last_output_chunk_at: Option<i64>,
    pub last_esc_at: Option<i64>,
    pub active_subagents: Vec<Subagent>,
    pub stop_held_for_subagents: bool,
    pub pre_error_state: Option<PreError>,
    pub title_held: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct StatusConfig {
    pub activity_byte_threshold: i64,
}

impl Default for StatusConfig {
    fn default() -> Self {
        Self {
            activity_byte_threshold: 1024,
        }
    }
}

pub const IDLE_THRESHOLD_MS: i64 = 2000;
pub const HOOK_IDLE_BACKSTOP_MS: i64 = 30_000;
pub const INPUT_GATE_MS: i64 = 2000;
pub const INACTIVITY_RESET_MS: i64 = 3000;
pub const ESC_DOUBLE_PRESS_WINDOW_MS: i64 = 750;
pub const SUBAGENT_STALE_MS: i64 = 2 * 60 * 60_000;
pub const ACTIVITY_HIT_COUNT: usize = 5;
pub const ACTIVITY_HIT_WINDOW_MS: i64 = 5_000;
pub const SHELL_USER_STOP_CODES: [i64; 2] = [130, 143];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StatusEvent {
    Hook {
        transition: Transition,
        now: i64,
        #[serde(default)]
        starts_turn: Option<bool>,
    },
    AgentDetected,
    AgentExited,
    ShellCommandStarted {
        now: i64,
    },
    ShellCommandEnded {
        #[serde(default)]
        exit: Option<i64>,
    },
    Output {
        bytes: i64,
        now: i64,
    },
    Keystroke {
        key: Key,
        esc_required: i64,
        now: i64,
    },
    SubagentStarted {
        agent_id: String,
        now: i64,
    },
    SubagentStopped {
        agent_id: String,
        now: i64,
    },
    Title {
        status: TitleStatus,
        now: i64,
        #[serde(default)]
        starts_turn: Option<bool>,
    },
    TitleTurnEnded {
        now: i64,
    },
    PtyExited {
        code: Option<i64>,
    },
    Tick {
        now: i64,
        #[serde(default)]
        rule: Option<String>,
    },
    Focus,
    Click,
    RecordOutput {
        now: i64,
    },
    RecordError,
    RecordExitSuccess,
    ClearError,
    ClearWaiting,
    ClearActive,
}

impl StatusState {
    pub fn initial(mode: Mode) -> Self {
        Self {
            state: DotState::Idle,
            mode,
            hook_driven: false,
            working_since: None,
            last_activity_at: None,
            shell_command_running: false,
            bytes_since_idle: 0,
            threshold_hit_times: Vec::new(),
            last_input_at: 0,
            last_output_chunk_at: None,
            last_esc_at: None,
            active_subagents: Vec::new(),
            stop_held_for_subagents: false,
            pre_error_state: None,
            title_held: false,
        }
    }
}

/// Whether an event opens a **Turn** (ADR-0027).
pub fn event_starts_turn(e: &StatusEvent) -> bool {
    matches!(
        e,
        StatusEvent::Hook { starts_turn: Some(true), .. }
            | StatusEvent::Title { starts_turn: Some(true), .. }
    )
}

/// Same as `recordThresholdHit` in `activityGate.ts`.
pub fn record_threshold_hit(hit_times: &[i64], now: i64) -> (Vec<i64>, bool) {
    let cutoff = now - ACTIVITY_HIT_WINDOW_MS;
    let mut pruned: Vec<i64> = hit_times.iter().copied().filter(|t| *t >= cutoff).collect();
    pruned.push(now);
    if pruned.len() >= ACTIVITY_HIT_COUNT {
        (Vec::new(), true)
    } else {
        (pruned, false)
    }
}

/// Same as `classifyShellExit` in `activityGate.ts`: true for a failure.
pub fn shell_exit_is_error(code: Option<i64>) -> bool {
    matches!(code, Some(c) if c != 0 && !SHELL_USER_STOP_CODES.contains(&c))
}

// ── Atomic transitions ──

fn record_activity(mut s: StatusState, now: i64) -> StatusState {
    if s.state == DotState::Waiting && s.mode == Mode::Agent {
        s.last_activity_at = Some(now);
        return s;
    }
    if s.state == DotState::Working {
        s.last_activity_at = Some(now);
        return s;
    }
    s.state = DotState::Working;
    s.working_since = Some(now);
    s.last_activity_at = Some(now);
    s.pre_error_state = None;
    s
}

fn record_error(mut s: StatusState) -> StatusState {
    s.state = DotState::Error;
    s.pre_error_state = None;
    s
}

fn record_exit_success(mut s: StatusState) -> StatusState {
    s.state = if s.mode == Mode::Agent {
        DotState::Ready
    } else {
        DotState::Idle
    };
    s.pre_error_state = None;
    s
}

fn mark_idle(mut s: StatusState) -> StatusState {
    if s.state == DotState::Idle || s.state == DotState::Error {
        return s;
    }
    if s.state == DotState::Waiting && s.mode == Mode::Agent {
        return s;
    }
    if s.state == DotState::Working && s.mode == Mode::Agent {
        return s;
    }
    if s.state == DotState::Working && s.shell_command_running {
        return s;
    }
    s.state = DotState::Idle;
    s
}

fn clear_error(mut s: StatusState) -> StatusState {
    if s.state != DotState::Error {
        return s;
    }
    if let Some(pre) = s.pre_error_state {
        s.state = pre.into();
        s.pre_error_state = None;
        return s;
    }
    s.state = DotState::Idle;
    s.pre_error_state = None;
    s.active_subagents = Vec::new();
    s.stop_held_for_subagents = false;
    s
}

fn clear_waiting(mut s: StatusState) -> StatusState {
    if s.state == DotState::Waiting {
        s.state = DotState::Idle;
    }
    s
}

fn clear_active(mut s: StatusState) -> StatusState {
    if s.state == DotState::Working && s.mode == Mode::Agent {
        s.state = DotState::Idle;
        s.active_subagents = Vec::new();
        s.stop_held_for_subagents = false;
    }
    s
}

fn apply_hook(mut s: StatusState, transition: Transition, now: i64) -> StatusState {
    match transition {
        Transition::Attach => {
            s.hook_driven = true;
            s
        }
        Transition::Resume => {
            if s.state == DotState::Waiting && s.mode == Mode::Agent {
                s.state = DotState::Working;
                s.hook_driven = true;
                s.working_since = Some(now);
                s.last_activity_at = Some(now);
            }
            s
        }
        Transition::Working => {
            s.state = DotState::Working;
            s.hook_driven = true;
            s.working_since = Some(now);
            s.last_activity_at = Some(now);
            s.stop_held_for_subagents = false;
            s.pre_error_state = None;
            s
        }
        Transition::Ready if !s.active_subagents.is_empty() => {
            s.state = DotState::Working;
            s.hook_driven = true;
            s.stop_held_for_subagents = true;
            s.pre_error_state = None;
            s
        }
        Transition::ErrorMidTurn => {
            let pre = if s.state == DotState::Error {
                s.pre_error_state
            } else if s.mode != Mode::Agent {
                None
            } else {
                match s.state {
                    DotState::Waiting => Some(PreError::Waiting),
                    DotState::Working | DotState::Ready => Some(PreError::Working),
                    _ => None,
                }
            };
            s.state = DotState::Error;
            s.hook_driven = true;
            s.pre_error_state = pre;
            s
        }
        Transition::Error => {
            s.state = DotState::Error;
            s.hook_driven = true;
            s.stop_held_for_subagents = false;
            s.pre_error_state = None;
            s
        }
        Transition::Idle => {
            s.state = DotState::Idle;
            s.hook_driven = true;
            s.last_esc_at = None;
            s.active_subagents = Vec::new();
            s.stop_held_for_subagents = false;
            s.pre_error_state = None;
            s
        }
        Transition::Waiting | Transition::Ready => {
            s.state = if transition == Transition::Waiting {
                DotState::Waiting
            } else {
                DotState::Ready
            };
            s.hook_driven = true;
            s.pre_error_state = None;
            s
        }
    }
}

// ── Subagent lifecycle ──

fn subagent_started(mut s: StatusState, id: &str, now: i64) -> StatusState {
    s.active_subagents.retain(|a| a.id != id);
    s.active_subagents.push(Subagent {
        id: id.to_string(),
        started_at: now,
    });
    s.hook_driven = true;
    match s.state {
        DotState::Working => {
            s.last_activity_at = Some(now);
        }
        DotState::Waiting | DotState::Error => {}
        _ => {
            s.state = DotState::Working;
            s.working_since = Some(now);
            s.last_activity_at = Some(now);
        }
    }
    s
}

fn subagent_stopped(mut s: StatusState, id: &str) -> StatusState {
    let before = s.active_subagents.len();
    s.active_subagents.retain(|a| a.id != id);
    if s.active_subagents.len() == before {
        return s;
    }
    if s.active_subagents.is_empty() && s.stop_held_for_subagents && s.state == DotState::Working
    {
        s.stop_held_for_subagents = false;
        s.state = DotState::Ready;
    }
    s
}

// ── Compound handlers ──

fn reduce_output(mut s: StatusState, bytes: i64, now: i64, config: &StatusConfig) -> StatusState {
    if s.mode != Mode::Agent {
        return s;
    }
    if s.hook_driven {
        s.last_activity_at = Some(now);
        return s;
    }
    if now - s.last_input_at <= INPUT_GATE_MS {
        return s;
    }
    let mut bytes_since_idle = s.bytes_since_idle;
    if let Some(last) = s.last_output_chunk_at {
        if now - last > INACTIVITY_RESET_MS {
            bytes_since_idle = 0;
        }
    }
    bytes_since_idle += bytes;

    if s.state == DotState::Working {
        s.bytes_since_idle = bytes_since_idle;
        s.last_output_chunk_at = Some(now);
        s.last_activity_at = Some(now);
        return s;
    }

    if bytes_since_idle >= config.activity_byte_threshold {
        let (hits, fire) = record_threshold_hit(&s.threshold_hit_times, now);
        s.bytes_since_idle = 0;
        s.threshold_hit_times = hits;
        s.last_output_chunk_at = Some(now);
        return if fire { record_activity(s, now) } else { s };
    }
    s.bytes_since_idle = bytes_since_idle;
    s.last_output_chunk_at = Some(now);
    s
}

fn reduce_keystroke(s: StatusState, key: Key, esc_required: i64, now: i64) -> StatusState {
    let acked = if s.state == DotState::Error && s.pre_error_state.is_some() {
        clear_error(s)
    } else {
        s
    };
    let mut base = acked;
    base.last_input_at = now;
    base.bytes_since_idle = 0;

    if base.state == DotState::Waiting && base.mode == Mode::Agent {
        return match key {
            Key::Esc => clear_waiting(base),
            Key::Answer => apply_hook(base, Transition::Working, now),
            Key::Other => base,
        };
    }

    if base.state == DotState::Working && base.mode == Mode::Agent {
        if key == Key::Esc {
            let follow_up = base
                .last_esc_at
                .is_some_and(|t| now - t <= ESC_DOUBLE_PRESS_WINDOW_MS);
            if esc_required == 1 || follow_up {
                base.state = DotState::Idle;
                base.last_esc_at = None;
                base.active_subagents = Vec::new();
                base.stop_held_for_subagents = false;
                return base;
            }
            base.last_esc_at = Some(now);
            return base;
        }
        base.last_esc_at = None;
        return base;
    }

    mark_idle(clear_error(base))
}

fn reduce_tick(mut s: StatusState, now: i64) -> StatusState {
    if s.state != DotState::Working || s.shell_command_running || s.title_held {
        return s;
    }
    if !s.active_subagents.is_empty() {
        let before = s.active_subagents.len();
        s.active_subagents
            .retain(|a| now - a.started_at <= SUBAGENT_STALE_MS);
        if s.active_subagents.len() == before {
            return s;
        }
        if s.active_subagents.is_empty() && s.stop_held_for_subagents {
            s.stop_held_for_subagents = false;
            s.state = if s.mode == Mode::Agent {
                DotState::Ready
            } else {
                DotState::Idle
            };
        }
        return s;
    }
    let Some(last) = s.last_activity_at.or(s.working_since) else {
        return s;
    };
    let threshold = if s.hook_driven {
        HOOK_IDLE_BACKSTOP_MS
    } else {
        IDLE_THRESHOLD_MS
    };
    if now - last > threshold {
        s.state = if s.mode == Mode::Agent {
            DotState::Ready
        } else {
            DotState::Idle
        };
    }
    s
}

fn reduce_title(mut s: StatusState, status: TitleStatus, now: i64) -> StatusState {
    if s.mode != Mode::Agent {
        return s;
    }
    match status {
        TitleStatus::None => {
            s.title_held = false;
            s
        }
        TitleStatus::Waiting => {
            s.state = DotState::Waiting;
            s.hook_driven = true;
            s.title_held = true;
            s.pre_error_state = None;
            s
        }
        TitleStatus::Working if s.state == DotState::Working => {
            s.hook_driven = true;
            s.title_held = true;
            s.last_activity_at = Some(now);
            s
        }
        TitleStatus::Working => {
            s.state = DotState::Working;
            s.hook_driven = true;
            s.title_held = true;
            s.working_since = Some(now);
            s.last_activity_at = Some(now);
            s.stop_held_for_subagents = false;
            s.pre_error_state = None;
            s
        }
    }
}

/// The status reducer: `statusReducer` in `statusReducer.ts`.
pub fn reduce(s: StatusState, e: &StatusEvent, config: &StatusConfig) -> StatusState {
    match e {
        StatusEvent::Hook { transition, now, .. } => apply_hook(s, *transition, *now),
        StatusEvent::Title { status, now, .. } => reduce_title(s, *status, *now),
        StatusEvent::TitleTurnEnded { now } => {
            if s.mode == Mode::Agent && matches!(s.state, DotState::Working | DotState::Waiting) {
                apply_hook(s, Transition::Idle, *now)
            } else {
                s
            }
        }
        StatusEvent::AgentDetected => {
            let mut s = s;
            if s.mode != Mode::Agent {
                s.mode = Mode::Agent;
                s.shell_command_running = false;
            }
            s
        }
        StatusEvent::AgentExited => {
            let mut s = s;
            if s.mode != Mode::Shell {
                s.mode = Mode::Shell;
                s.hook_driven = false;
                s.active_subagents = Vec::new();
                s.stop_held_for_subagents = false;
                s.title_held = false;
            }
            s
        }
        StatusEvent::ShellCommandStarted { now } => {
            if s.mode == Mode::Agent {
                return s;
            }
            let mut s = s;
            s.shell_command_running = true;
            record_activity(s, *now)
        }
        StatusEvent::ShellCommandEnded { exit } => {
            if s.mode == Mode::Agent {
                return s;
            }
            let mut s = s;
            s.shell_command_running = false;
            if shell_exit_is_error(*exit) {
                record_error(s)
            } else {
                record_exit_success(s)
            }
        }
        StatusEvent::Output { bytes, now } => reduce_output(s, *bytes, *now, config),
        StatusEvent::Keystroke {
            key,
            esc_required,
            now,
        } => reduce_keystroke(s, *key, *esc_required, *now),
        StatusEvent::SubagentStarted { agent_id, now } => subagent_started(s, agent_id, *now),
        StatusEvent::SubagentStopped { agent_id, .. } => subagent_stopped(s, agent_id),
        StatusEvent::PtyExited { code } => {
            let mut s = s;
            s.active_subagents = Vec::new();
            s.stop_held_for_subagents = false;
            s.title_held = false;
            if shell_exit_is_error(*code) {
                record_error(s)
            } else {
                record_exit_success(s)
            }
        }
        StatusEvent::Tick { now, .. } => reduce_tick(s, *now),
        StatusEvent::Focus => mark_idle(s),
        StatusEvent::Click => mark_idle(clear_error(s)),
        StatusEvent::RecordOutput { now } => record_activity(s, *now),
        StatusEvent::RecordError => record_error(s),
        StatusEvent::RecordExitSuccess => record_exit_success(s),
        StatusEvent::ClearError => clear_error(s),
        StatusEvent::ClearWaiting => clear_waiting(s),
        StatusEvent::ClearActive => clear_active(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(mode: Mode, events: &[StatusEvent]) -> StatusState {
        events.iter().fold(StatusState::initial(mode), |s, e| {
            reduce(s, e, &StatusConfig::default())
        })
    }

    #[test]
    fn a_turn_runs_working_to_ready() {
        let s = run(
            Mode::Agent,
            &[
                StatusEvent::Hook { transition: Transition::Working, now: 1, starts_turn: Some(true) },
                StatusEvent::Hook { transition: Transition::Ready, now: 2, starts_turn: None },
            ],
        );
        assert_eq!(s.state, DotState::Ready);
        assert!(s.hook_driven);
    }

    #[test]
    fn a_ready_with_live_subagents_is_held_until_they_drain() {
        let s = run(
            Mode::Agent,
            &[
                StatusEvent::Hook { transition: Transition::Working, now: 1, starts_turn: None },
                StatusEvent::SubagentStarted { agent_id: "a".into(), now: 2 },
                StatusEvent::Hook { transition: Transition::Ready, now: 3, starts_turn: None },
            ],
        );
        assert_eq!(s.state, DotState::Working);
        assert!(s.stop_held_for_subagents);
        let s = reduce(
            s,
            &StatusEvent::SubagentStopped { agent_id: "a".into(), now: 4 },
            &StatusConfig::default(),
        );
        assert_eq!(s.state, DotState::Ready);
    }

    #[test]
    fn a_mid_turn_failure_returns_to_working_when_acknowledged() {
        let s = run(
            Mode::Agent,
            &[
                StatusEvent::Hook { transition: Transition::Working, now: 1, starts_turn: None },
                StatusEvent::Hook { transition: Transition::ErrorMidTurn, now: 2, starts_turn: None },
                StatusEvent::Click,
            ],
        );
        assert_eq!(s.state, DotState::Working);
    }

    #[test]
    fn shells_skip_ready() {
        let s = run(
            Mode::Shell,
            &[
                StatusEvent::ShellCommandStarted { now: 1 },
                StatusEvent::ShellCommandEnded { exit: Some(0) },
            ],
        );
        assert_eq!(s.state, DotState::Idle);
        let s = run(
            Mode::Shell,
            &[
                StatusEvent::ShellCommandStarted { now: 1 },
                StatusEvent::ShellCommandEnded { exit: Some(130) },
            ],
        );
        assert_eq!(s.state, DotState::Idle, "Ctrl+C is not a failure");
    }

    #[test]
    fn events_read_the_typescript_json_shape() {
        let e: StatusEvent = serde_json::from_str(
            r#"{"kind":"keystroke","key":"esc","escRequired":2,"now":5}"#,
        )
        .unwrap();
        assert_eq!(e, StatusEvent::Keystroke { key: Key::Esc, esc_required: 2, now: 5 });
        let e: StatusEvent =
            serde_json::from_str(r#"{"kind":"shellCommandEnded"}"#).unwrap();
        assert_eq!(e, StatusEvent::ShellCommandEnded { exit: None });
    }

    /// Random event sequences recorded from the TypeScript reducer
    /// (`statusParity.test.ts` writes and checks the file): every state after
    /// every event must match.
    #[test]
    fn matches_the_typescript_reducer() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/statusParity.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut checked = 0;
        for (i, run) in doc["runs"].as_array().unwrap().iter().enumerate() {
            let mode: Mode = serde_json::from_value(run["mode"].clone()).unwrap();
            let config = StatusConfig {
                activity_byte_threshold: run["threshold"].as_i64().unwrap(),
            };
            let mut s = StatusState::initial(mode);
            for (j, step) in run["steps"].as_array().unwrap().iter().enumerate() {
                let e: StatusEvent = serde_json::from_value(step["event"].clone())
                    .unwrap_or_else(|err| panic!("run {i} step {j}: {err}: {}", step["event"]));
                s = reduce(s, &e, &config);
                let want: StatusState = serde_json::from_value(step["state"].clone())
                    .unwrap_or_else(|err| panic!("run {i} step {j} state: {err}"));
                assert_eq!(s, want, "run {i} step {j} after {}", step["event"]);
                assert_eq!(
                    event_starts_turn(&e),
                    step["startsTurn"].as_bool().unwrap(),
                    "run {i} step {j}"
                );
                checked += 1;
            }
        }
        assert!(checked > 1000, "only {checked} steps checked");
    }
}

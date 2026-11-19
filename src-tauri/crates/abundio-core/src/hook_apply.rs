//! An Agent's hook, applied where the PTY runs (docs/plans/remote-hosts.md
//! phase 6d): routed (`hook_route.rs`), then each step applied to the status
//! store with the same guards the Window's store had (`ptyActivityStore`:
//! `setAgentPty`, `applyHookEvent`, `subagentStarted`/`Stopped`, and
//! `applySessionEnd`). The Host keeps the status with no Window.
//!
//! What only a Window keeps (which Agent a pane runs, for its icon and the
//! Turn tracker; the Agent and its session id in the layout; a Session end
//! for Turn telemetry) is in the [`HookNotice`], sent to the owning Window
//! before the status updates, as it came before the status change there.

use serde::Serialize;
use serde_json::Value;

use crate::hook_route::{self, HookStep, HookTransition, RouteState};
use crate::status_machine::{Mode, StatusConfig, StatusEvent};
use crate::status_store::{StatusStore, StatusUpdate};

/// What the Window does besides the status (`agent-hook-applied`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookNotice {
    pub pty_id: String,
    pub agent: String,
    /// The hook proves an Agent runs in the pane: record which, and stamp it
    /// (with `session_id`) on the pane.
    pub adopted: bool,
    /// A Session end: Turn telemetry closes the open Turn as one.
    pub session_end: bool,
    pub session_id: Option<String>,
    /// Why nothing happened, when nothing did.
    pub dropped: Option<String>,
}

/// What applying one hook did.
pub struct Applied {
    pub notice: HookNotice,
    pub updates: Vec<StatusUpdate>,
}

/// Apply one hook (`event` from `agent`, `payload` its raw JSON) at `now`.
pub fn apply(
    status: &StatusStore,
    pty_id: &str,
    agent: &str,
    event: &str,
    payload: &str,
    now: i64,
    config: &StatusConfig,
) -> Applied {
    let payload: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let live: Vec<String> = status
        .view(pty_id)
        .map(|v| v.active_subagents.iter().map(|s| s.id.clone()).collect())
        .unwrap_or_default();
    let has_subagent = |id: &str| live.iter().any(|l| l == id);
    let route = hook_route::route(
        agent,
        event,
        &payload,
        &RouteState {
            has_subagent: &has_subagent,
            title_status_seen: status.title_status_seen(pty_id),
            open_code_cancelled: status.open_code_cancelled(pty_id),
        },
    );
    status.set_open_code_cancelled(pty_id, route.open_code_cancelled);

    let adopted = route.steps.iter().any(|s| !matches!(s, HookStep::SessionEnd));
    if adopted {
        // The hook proves which Agent runs here; its titles are read by it.
        status.set_agent(pty_id, Some(agent.to_string()));
    }
    let mut updates = Vec::new();
    let mut push = |u: Option<StatusUpdate>| updates.extend(u);
    let is_agent = |s: &StatusStore| s.view(pty_id).is_some_and(|v| v.mode == Mode::Agent);
    for step in &route.steps {
        match step {
            HookStep::SessionEnd => {
                if is_agent(status) {
                    push(status.apply_from_host(pty_id, hook(HookTransition::Idle, now, None), config));
                }
            }
            HookStep::Transition { transition, turn_start } => {
                adopt(status, pty_id, config, &mut push);
                if status.has(pty_id) {
                    push(status.apply_from_host(pty_id, hook(*transition, now, Some(*turn_start)), config));
                }
            }
            HookStep::SubagentStarted { id } | HookStep::SubagentStopped { id } => {
                adopt(status, pty_id, config, &mut push);
                if status.has(pty_id) {
                    let e = if matches!(step, HookStep::SubagentStarted { .. }) {
                        StatusEvent::SubagentStarted { agent_id: id.clone(), now }
                    } else {
                        StatusEvent::SubagentStopped { agent_id: id.clone(), now }
                    };
                    push(status.apply_from_host(pty_id, e, config));
                }
            }
        }
    }
    Applied {
        notice: HookNotice {
            pty_id: pty_id.to_string(),
            agent: agent.to_string(),
            adopted,
            session_end: route.steps.contains(&HookStep::SessionEnd),
            session_id: if adopted { hook_route::session_id(agent, event, &payload) } else { None },
            dropped: route.dropped,
        },
        updates,
    }
}

fn hook(t: HookTransition, now: i64, starts_turn: Option<bool>) -> StatusEvent {
    StatusEvent::Hook { transition: t.status(), now, starts_turn }
}

/// `setAgentPty`'s status half: a pane with a status that is not yet in
/// agent mode enters it.
fn adopt(status: &StatusStore, pty_id: &str, config: &StatusConfig, push: &mut impl FnMut(Option<StatusUpdate>)) {
    if status.view(pty_id).is_some_and(|v| v.mode != Mode::Agent) {
        push(status.apply_from_host(pty_id, StatusEvent::AgentDetected, config));
    }
}

/// The time now, in the milliseconds the status machine counts in.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_sink::ClientId;
    use crate::status_machine::DotState;
    use crate::status_store::StatusOp;

    fn store_with(mode: Mode) -> StatusStore {
        let s = StatusStore::new();
        s.run_op(&ClientId::from("w"), StatusOp::Init { pty_id: "p".into(), mode: Some(mode) }, &StatusConfig::default());
        s
    }

    fn hook_in(s: &StatusStore, agent: &str, event: &str, payload: &str, now: i64) -> Applied {
        apply(s, "p", agent, event, payload, now, &StatusConfig::default())
    }

    #[test]
    fn a_prompt_adopts_the_agent_and_starts_its_turn() {
        let s = store_with(Mode::Shell);
        let a = hook_in(&s, "claude", "UserPromptSubmit", r#"{"session_id":"abc"}"#, 10);
        assert_eq!(
            a.notice,
            HookNotice {
                pty_id: "p".into(),
                agent: "claude".into(),
                adopted: true,
                session_end: false,
                session_id: Some("abc".into()),
                dropped: None,
            }
        );
        let v = s.view("p").unwrap();
        assert_eq!((v.mode, v.state, v.hook_driven), (Mode::Agent, DotState::Working, true));
        let causes: Vec<_> = a.updates.iter().filter_map(|u| u.change.as_ref().map(|c| c.cause.clone())).collect();
        assert_eq!(causes[0], StatusEvent::AgentDetected);
        assert!(matches!(causes.last(), Some(StatusEvent::Hook { starts_turn: Some(true), .. })));
    }

    #[test]
    fn a_session_end_never_adopts_and_idles_only_an_agent() {
        let shell = store_with(Mode::Shell);
        let a = hook_in(&shell, "claude", "SessionEnd", "{}", 10);
        assert!(!a.notice.adopted && a.notice.session_end);
        assert_eq!(shell.view("p").unwrap().mode, Mode::Shell);
        assert!(a.updates.is_empty());

        let agent = store_with(Mode::Agent);
        hook_in(&agent, "claude", "UserPromptSubmit", "{}", 10);
        hook_in(&agent, "claude", "SessionEnd", "{}", 20);
        assert_eq!(agent.view("p").unwrap().state, DotState::Idle);
    }

    #[test]
    fn subagents_hold_the_stop_until_they_finish() {
        let s = store_with(Mode::Agent);
        hook_in(&s, "claude", "UserPromptSubmit", "{}", 10);
        hook_in(&s, "claude", "SubagentStart", r#"{"agent_id":"x"}"#, 11);
        hook_in(&s, "claude", "Stop", "{}", 12);
        assert_eq!(s.view("p").unwrap().state, DotState::Working);
        hook_in(&s, "claude", "SubagentStop", r#"{"agent_id":"x"}"#, 13);
        assert_eq!(s.view("p").unwrap().state, DotState::Ready);
    }

    #[test]
    fn a_title_status_agents_hook_waits_for_its_title() {
        let s = store_with(Mode::Agent);
        let a = hook_in(&s, "vibe", "post_agent", "{}", 10);
        assert_eq!(a.notice.dropped.as_deref(), Some("no_title_status"));
        s.set_agent("p", Some("vibe".into()));
        s.title_changed("p", ">> Vibe", 10, &StatusConfig::default());
        let a = hook_in(&s, "vibe", "post_agent", "{}", 11);
        assert_eq!(a.notice.dropped, None);
    }

    #[test]
    fn opencode_keeps_a_cancelled_turn_idle() {
        let s = store_with(Mode::Agent);
        hook_in(&s, "opencode", "session.status", r#"{"status":{"type":"busy"}}"#, 10);
        hook_in(&s, "opencode", "session.error", r#"{"error":{"name":"MessageAbortedError"}}"#, 11);
        let a = hook_in(&s, "opencode", "session.idle", "{}", 12);
        assert_eq!(a.notice.dropped.as_deref(), Some("cancel_gate"));
        assert_eq!(s.view("p").unwrap().state, DotState::Idle);
    }

    #[test]
    fn a_pty_with_no_status_yet_is_only_noticed() {
        let s = StatusStore::new();
        let a = hook_in(&s, "claude", "UserPromptSubmit", "not json", 10);
        assert!(a.notice.adopted);
        assert!(a.updates.is_empty());
        assert!(s.view("p").is_none());
    }
}

//! From an Agent's hook to the steps its pane's status takes (ADR-0062,
//! docs/plans/remote-hosts.md phase 6d): a port of the Window's
//! `agentHookMap.ts` (`routeHookEvent`, `mapHookEvent`,
//! `mapSubagentHookEvent`, `mapOpenCodeV2Event`, `openCodeEventKey`,
//! `openCodeCancelGate`, `isTurnStartEvent`) and `agentSessionId.ts`. The
//! reasons for every rule are written there; this file keeps the same order
//! and the same tables, held to them by `fixtures/hookRoute.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A hook's transition, spelled as the Window spells it (`HookTransition`,
/// where Working is `active`); [`HookTransition::status`] gives the
/// reducer's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookTransition {
    Active,
    Waiting,
    Ready,
    Idle,
    Error,
    ErrorMidTurn,
    Resume,
    Attach,
}

impl HookTransition {
    /// The status machine's transition.
    pub fn status(self) -> crate::status_machine::Transition {
        use crate::status_machine::Transition as T;
        match self {
            HookTransition::Active => T::Working,
            HookTransition::Waiting => T::Waiting,
            HookTransition::Ready => T::Ready,
            HookTransition::Idle => T::Idle,
            HookTransition::Error => T::Error,
            HookTransition::ErrorMidTurn => T::ErrorMidTurn,
            HookTransition::Resume => T::Resume,
            HookTransition::Attach => T::Attach,
        }
    }
}

/// One step a hook drives (`HookStep`). A transition and a Subagent step
/// also prove an Agent runs in the pane; a Session end never does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HookStep {
    Transition { transition: HookTransition, turn_start: bool },
    SubagentStarted { id: String },
    SubagentStopped { id: String },
    SessionEnd,
}

/// What routing decided (`HookRoute`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRoute {
    pub steps: Vec<HookStep>,
    pub open_code_cancelled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<String>,
}

/// What a pane knows that routing reads (`HookRouteState`).
pub struct RouteState<'a> {
    pub has_subagent: &'a dyn Fn(&str) -> bool,
    pub title_status_seen: bool,
    pub open_code_cancelled: bool,
}

/// A mapped transition, or the Session end ("sessionReset").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mapped {
    T(HookTransition),
    SessionReset,
}

use Mapped::{SessionReset, T};
use HookTransition::*;

fn table(agent: &str, event: &str) -> Option<Mapped> {
    let claude = |e: &str| match e {
        "UserPromptSubmit" => Some(T(Active)),
        "PermissionRequest" => Some(T(Waiting)),
        "Stop" => Some(T(Ready)),
        "StopFailure" => Some(T(Error)),
        "SessionEnd" => Some(SessionReset),
        _ => None,
    };
    match agent {
        "claude" | "qwen" => claude(event),
        "copilot" => match event {
            "userPromptSubmitted" => Some(T(Active)),
            "notification" => Some(T(Waiting)),
            "agentStop" => Some(T(Ready)),
            "errorOccurred" => Some(T(ErrorMidTurn)),
            "sessionEnd" => Some(SessionReset),
            _ => None,
        },
        "gemini" => match event {
            "BeforeAgent" => Some(T(Active)),
            "AfterAgent" => Some(T(Ready)),
            "Notification" => Some(T(Waiting)),
            "SessionEnd" => Some(SessionReset),
            _ => None,
        },
        "codex" => match event {
            "UserPromptSubmit" => Some(T(Active)),
            "PermissionRequest" => Some(T(Waiting)),
            "Stop" => Some(T(Ready)),
            _ => None,
        },
        "opencode" => match event {
            "session.status:busy" => Some(T(Active)),
            "session.status:retry" => Some(T(Resume)),
            "permission.updated" => Some(T(Waiting)),
            "permission.replied" => Some(T(Active)),
            "session.idle" => Some(T(Ready)),
            "session.error:MessageAbortedError" => Some(T(Idle)),
            "session.error" => Some(T(Error)),
            "session.deleted" => Some(SessionReset),
            _ => None,
        },
        "kimi" => match event {
            "UserPromptSubmit" => Some(T(Active)),
            "PermissionRequest" => Some(T(Waiting)),
            "PermissionResult" => Some(T(Active)),
            "Stop" => Some(T(Ready)),
            "StopFailure" => Some(T(Error)),
            "Interrupt" => Some(T(Idle)),
            "SessionEnd" => Some(SessionReset),
            _ => None,
        },
        "grok" => match event {
            "SessionStart" => Some(T(Attach)),
            "UserPromptSubmit" => Some(T(Active)),
            "Notification" => Some(T(Waiting)),
            "PreToolUse" => Some(T(Resume)),
            "PermissionDenied" => Some(T(Active)),
            "Stop" => Some(T(Ready)),
            "StopFailure" => Some(T(Error)),
            "SessionEnd" => Some(SessionReset),
            _ => None,
        },
        "vibe" => match event {
            "post_agent" => Some(T(Ready)),
            _ => None,
        },
        _ => None,
    }
}

const COPILOT_WAITING_TOOLS: [&str; 2] = ["exit_plan_mode", "ask_user"];
const GROK_BLOCKING_PROMPT_MESSAGES: [&str; 2] = ["Plan approval requested", "Diff review requested"];

/// A payload field, if it is a string (empty included, as `typeof === "string"`).
fn field<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(Value::as_str)
}

/// A non-empty string field (`str()` in the Window).
fn nonempty<'a>(p: Option<&'a Value>, key: &str) -> Option<&'a str> {
    p?.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `mapHookEvent`.
fn map_hook_event(agent: &str, event: &str, p: &Value) -> Option<Mapped> {
    if agent == "grok" && event == "Notification" && field(p, "notificationType") == Some("permission_prompt") {
        let message = field(p, "message");
        if !message.is_some_and(|m| GROK_BLOCKING_PROMPT_MESSAGES.contains(&m)) {
            let mode = field(p, "permissionMode");
            if matches!(mode, Some("auto" | "bypassPermissions")) {
                return Some(T(Resume));
            }
            if mode == Some("plan") && message == Some("Tool permission requested") {
                return Some(T(Resume));
            }
        }
    }
    if agent == "grok" && event == "Stop" {
        return Some(match field(p, "reason") {
            Some("cancelled") => T(Idle),
            Some("error") => T(Error),
            _ => T(Ready),
        });
    }
    if agent == "copilot"
        && event == "preToolUse"
        && field(p, "toolName").is_some_and(|t| COPILOT_WAITING_TOOLS.contains(&t))
    {
        return Some(T(Waiting));
    }
    table(agent, event).or_else(|| match event.find(':') {
        Some(i) if i > 0 => table(agent, &event[..i]),
        _ => None,
    })
}

/// `isTurnStartEvent`.
fn is_turn_start(agent: &str, event: &str) -> bool {
    match agent {
        "claude" | "qwen" | "kimi" | "codex" | "grok" => event == "UserPromptSubmit",
        "copilot" => event == "userPromptSubmitted",
        "gemini" => event == "BeforeAgent",
        "opencode" => event == "session.status:busy",
        _ => false,
    }
}

/// `openCodeEventKey`.
fn open_code_event_key(event: &str, p: &Value) -> String {
    let inner = |outer: &str, key: &str| nonempty(p.get(outer), key).map(str::to_string);
    match event {
        "session.status" => inner("status", "type").map_or(event.to_string(), |t| format!("{event}:{t}")),
        "session.error" => inner("error", "name").map_or(event.to_string(), |n| format!("{event}:{n}")),
        _ => event.to_string(),
    }
}

/// A Subagent signal (`SubagentSignal`).
enum Signal {
    Started(String),
    Stopped(String),
    Ignored,
    Resume,
}

/// `mapSubagentHookEvent`.
fn map_subagent(agent: &str, event: &str, p: &Value, has_subagent: &dyn Fn(&str) -> bool) -> Option<Signal> {
    let p = Some(p);
    match agent {
        "claude" | "qwen" | "codex" | "kimi" | "grok" => {
            if event != "SubagentStart" && event != "SubagentStop" {
                return None;
            }
            let id = nonempty(p, "agent_id")
                .or_else(|| nonempty(p, "agentId"))
                .or_else(|| nonempty(p, "subagentId"))?
                .to_string();
            Some(if event == "SubagentStart" { Signal::Started(id) } else { Signal::Stopped(id) })
        }
        "vibe" => nonempty(p, "parent_session_id").map(|_| Signal::Ignored),
        "copilot" => {
            if event != "subagentStart" && event != "subagentStop" {
                return None;
            }
            let id = nonempty(p, "agentName")?.to_string();
            Some(if event == "subagentStart" { Signal::Started(id) } else { Signal::Stopped(id) })
        }
        "opencode" => {
            let info = p.and_then(|v| v.get("info"));
            if event == "session.created" || event == "session.updated" {
                let id = nonempty(info, "id")?;
                return nonempty(info, "parentID").map(|_| Signal::Started(id.to_string()));
            }
            let id = nonempty(p, "sessionID").or_else(|| nonempty(info, "id"))?;
            if !has_subagent(id) {
                return None;
            }
            match event {
                "session.idle" | "session.error" | "session.deleted" => Some(Signal::Stopped(id.to_string())),
                "permission.updated" => None,
                "permission.replied" => Some(Signal::Resume),
                _ => Some(Signal::Ignored),
            }
        }
        _ => None,
    }
}

fn transition_steps(m: Mapped, turn_start: bool) -> Vec<HookStep> {
    match m {
        SessionReset => vec![HookStep::SessionEnd],
        T(transition) => vec![HookStep::Transition { transition, turn_start }],
    }
}

fn signal_steps(s: Signal) -> Vec<HookStep> {
    match s {
        Signal::Ignored => vec![],
        Signal::Resume => transition_steps(T(Resume), false),
        Signal::Started(id) => vec![HookStep::SubagentStarted { id }],
        Signal::Stopped(id) => vec![HookStep::SubagentStopped { id }],
    }
}

const OPENCODE_V2_SHOWN: &str = "abundio.session.shown";

/// `mapOpenCodeV2Event`, as steps; `None` when it maps to nothing.
fn open_code_v2(event: &str, p: &Value) -> Option<Vec<HookStep>> {
    if event == OPENCODE_V2_SHOWN {
        let running = p.get("running") == Some(&Value::Bool(true));
        let waiting = running && p.get("waiting") == Some(&Value::Bool(true));
        let mut steps = vec![HookStep::SessionEnd];
        if running {
            steps.extend(transition_steps(T(Active), false));
        }
        if waiting {
            steps.extend(transition_steps(T(Waiting), false));
        }
        return Some(steps);
    }
    let scope = field(p, "scope");
    if scope == Some("self") {
        let m = match event {
            "session.execution.started" => T(Active),
            "permission.asked" | "form.created" => T(Waiting),
            "permission.replied" | "form.replied" | "form.cancelled" => T(Active),
            "session.execution.succeeded" => T(Ready),
            "session.execution.failed" => T(Error),
            "session.execution.interrupted" => T(Idle),
            "session.retry.scheduled" => T(Resume),
            "session.deleted" => SessionReset,
            _ => return None,
        };
        return Some(transition_steps(m, event == "session.execution.started"));
    }
    if scope != Some("child") {
        return None;
    }
    let id = nonempty(Some(p), "sessionID")?.to_string();
    match event {
        "session.execution.started" => Some(signal_steps(Signal::Started(id))),
        "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted"
        | "session.deleted" => Some(signal_steps(Signal::Stopped(id))),
        "permission.asked" | "form.created" => Some(transition_steps(T(Waiting), false)),
        "permission.replied" | "form.replied" | "form.cancelled" => Some(transition_steps(T(Resume), false)),
        _ => None,
    }
}

/// Agents whose Working and Waiting come from their terminal title
/// (`hasTitleStatus`, ADR-0047).
fn has_title_status(agent: &str) -> bool {
    agent == "vibe"
}

/// `routeHookEvent`. `payload` is the parsed hook JSON (`Null` when it was
/// not JSON).
pub fn route(agent: &str, event: &str, payload: &Value, state: &RouteState) -> HookRoute {
    let keep = state.open_code_cancelled;
    let done = |steps: Vec<HookStep>, cancelled: bool, dropped: Option<&str>| HookRoute {
        steps,
        open_code_cancelled: cancelled,
        dropped: dropped.map(str::to_string),
    };
    if agent == "opencode" && payload.get("v") == Some(&Value::from(2)) {
        return match open_code_v2(event, payload) {
            Some(steps) => done(steps, keep, None),
            None => done(vec![], keep, Some("unmapped")),
        };
    }
    if let Some(signal) = map_subagent(agent, event, payload, state.has_subagent) {
        return done(signal_steps(signal), keep, None);
    }
    if has_title_status(agent) && !state.title_status_seen {
        return done(vec![], keep, Some("no_title_status"));
    }
    let key = if agent == "opencode" { open_code_event_key(event, payload) } else { event.to_string() };
    let Some(mapped) = map_hook_event(agent, &key, payload) else {
        return done(vec![], keep, Some("unmapped"));
    };
    let mut cancelled = keep;
    if agent == "opencode" {
        // `openCodeCancelGate`.
        if key == "session.error:MessageAbortedError" {
            cancelled = true;
        } else if key == "session.idle" && keep {
            return done(vec![], false, Some("cancel_gate"));
        } else if key == "session.status:busy" {
            cancelled = false;
        }
    }
    done(transition_steps(mapped, is_turn_start(agent, &key)), cancelled, None)
}

/// The Agent's own id for its conversation, from a hook payload
/// (`agentSessionIdFrom`): what a Session resume reopens (ADR-0050).
pub fn session_id(agent: &str, event: &str, payload: &Value) -> Option<String> {
    if !payload.is_object() {
        return None;
    }
    let p = Some(payload);
    let id = match agent {
        "claude" | "gemini" | "codex" | "qwen" | "kimi" => nonempty(p, "session_id"),
        "vibe" => match nonempty(p, "parent_session_id") {
            Some(_) => None,
            None => nonempty(p, "session_id"),
        },
        "copilot" if event == "preToolUse" => None,
        "copilot" | "grok" => nonempty(p, "sessionId"),
        "opencode" if payload.get("v") == Some(&Value::from(2)) && field(payload, "scope") == Some("self") => {
            nonempty(p, "sessionID")
        }
        _ => None,
    };
    id.map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        #[serde(flatten)]
        route: HookRoute,
        session_id: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        agent: String,
        event: String,
        payload: Value,
        live: Vec<String>,
        title_status_seen: bool,
        open_code_cancelled: bool,
        expected: Expected,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    #[test]
    fn routes_every_case_as_the_window_does() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/hookRoute.json");
        let fixture: Fixture = serde_json::from_str(raw).unwrap();
        assert!(fixture.cases.len() > 2000);
        for c in &fixture.cases {
            let live = |id: &str| c.live.iter().any(|l| l == id);
            let got = route(
                &c.agent,
                &c.event,
                &c.payload,
                &RouteState {
                    has_subagent: &live,
                    title_status_seen: c.title_status_seen,
                    open_code_cancelled: c.open_code_cancelled,
                },
            );
            let what = format!("{} {} {}", c.agent, c.event, c.payload);
            assert_eq!(got, c.expected.route, "{what}");
            assert_eq!(session_id(&c.agent, &c.event, &c.payload), c.expected.session_id, "{what}");
        }
    }
}

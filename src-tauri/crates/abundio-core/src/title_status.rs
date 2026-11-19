//! **Title status** (ADR-0047), read where the PTY runs
//! (docs/plans/remote-hosts.md phase 6d-3): an Agent that announces its state
//! in its terminal title (Mistral Vibe) has the title read from the PTY's
//! Rust screen, so a Host keeps that status with no Window.
//!
//! The rules are `src/lib/agentTitleMap.ts`'s (`readTitle`, `titleStep`,
//! `titleChange`), held equal by `fixtures/titleStatus.json`. The per-PTY
//! state lives in the status store (`StatusStore::title_changed`); [`listen`]
//! connects a PTY manager's titles to it and runs the grace window.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::event_sink::{Events, EventsExt};
use crate::status_machine::{StatusConfig, TitleStatus};
use crate::status_store::StatusStore;

/// How long a Turn end announced by the title waits for the turn-finished
/// hook before it is read as a cancel or failure (`TITLE_TURN_END_GRACE_MS`).
pub const TURN_END_GRACE_MS: u64 = 1500;

enum Match {
    Prefix,
    Suffix,
}

/// Mistral Vibe: `>> <title>` while a Turn runs, `? <title>` while it waits,
/// and in a blurred pane `<title> - Action Required`. See `agentTitleMap.ts`.
fn rules(agent: &str) -> Option<&'static [(Match, &'static str, TitleStatus)]> {
    match agent {
        "vibe" => Some(&[
            (Match::Prefix, ">> ", TitleStatus::Working),
            (Match::Prefix, "? ", TitleStatus::Waiting),
            (Match::Suffix, " - Action Required", TitleStatus::Waiting),
        ]),
        _ => None,
    }
}

/// Whether this Agent announces a Title status at all (`hasTitleStatus`).
pub fn has_title_status(agent: &str) -> bool {
    rules(agent).is_some()
}

/// One title, read: its status, and whether it proves the Agent's tab status
/// is on (only a prefix does). `None` when the Agent has no rules.
fn read_title(agent: Option<&str>, title: &str) -> Option<(TitleStatus, bool)> {
    for (how, text, status) in rules(agent?)? {
        let hit = match how {
            Match::Prefix => title.starts_with(text),
            Match::Suffix => title.ends_with(text),
        };
        if hit {
            return Some((*status, matches!(how, Match::Prefix)));
        }
    }
    Some((TitleStatus::None, false))
}

/// What one agent session's titles have said so far (`TitleTrack`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleTrack {
    pub status: Option<TitleStatus>,
    pub seen: bool,
    pub busy_before_bare: Option<TitleStatus>,
}

/// The Title status to hand the status machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub status: TitleStatus,
    pub starts_turn: bool,
}

/// What one title change asks of the pane (`TitleChange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleChange {
    pub track: TitleTrack,
    pub dispatch: Option<Dispatch>,
    pub await_turn_end: bool,
}

fn busy(s: Option<TitleStatus>) -> bool {
    matches!(s, Some(TitleStatus::Working | TitleStatus::Waiting))
}

/// `titleChange`: a title in an agent-mode pane running `agent`.
pub fn change(track: TitleTrack, agent: Option<&str>, title: &str) -> TitleChange {
    let unchanged = TitleChange { track, dispatch: None, await_turn_end: false };
    let Some((next, live)) = read_title(agent, title) else { return unchanged };
    let seen = track.seen || live;
    if !seen {
        return unchanged;
    }
    let prev = track.status;
    // `titleStep`.
    let (dispatch, await_turn_end) = if prev == Some(next) {
        (None, false)
    } else if next == TitleStatus::None {
        // A first plain title (the Agent's startup title) ends nothing.
        let was_busy = busy(prev);
        (was_busy.then_some(Dispatch { status: next, starts_turn: false }), was_busy)
    } else {
        let starts_turn = next == TitleStatus::Working
            && prev != Some(TitleStatus::Waiting)
            && track.busy_before_bare != Some(TitleStatus::Waiting);
        (Some(Dispatch { status: next, starts_turn }), false)
    };
    match dispatch {
        None => TitleChange {
            track: TitleTrack { seen, status: Some(next), ..track },
            dispatch: None,
            await_turn_end: false,
        },
        Some(d) => TitleChange {
            track: TitleTrack {
                seen,
                status: Some(next),
                busy_before_bare: if await_turn_end { prev } else { None },
            },
            dispatch: Some(d),
            await_turn_end,
        },
    }
}

/// `titleGraceEnded`: the grace window ran out with no new Title status.
pub fn grace_ended(track: TitleTrack) -> TitleTrack {
    TitleTrack { busy_before_bare: None, ..track }
}

/// Read every PTY's titles into `status`, telling each PTY's owning Window
/// (if any) what changed, and run the grace window after a Turn end.
pub fn listen(ptys: &crate::pty_manager::PtyManager, status: Arc<StatusStore>, events: Events) {
    ptys.on_title(Arc::new(move |pty: &str, title: &str| {
        let config = StatusConfig::default();
        let outcome = status.title_changed(pty, title, crate::hook_apply::now_ms(), &config);
        send(&status, &events, pty, outcome.update);
        if let Some(grace) = outcome.grace {
            let (status, events, pty) = (status.clone(), events.clone(), pty.to_string());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(TURN_END_GRACE_MS));
                let update = status.title_grace_ended(&pty, grace, crate::hook_apply::now_ms(), &config);
                send(&status, &events, &pty, update);
            });
        }
    }));
}

fn send(status: &StatusStore, events: &Events, pty: &str, update: Option<crate::status_store::StatusUpdate>) {
    if let (Some(update), Some(owner)) = (update, status.owner(pty)) {
        events.to_client(&owner, "status-updates", vec![update]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Step {
        Title { title: String, expected: TitleChange },
        Grace {
            #[serde(rename = "graceEnded")]
            _grace: bool,
            expected: GraceExpected,
        },
    }

    #[derive(Deserialize)]
    struct GraceExpected {
        track: TitleTrack,
    }

    #[derive(Deserialize)]
    struct Case {
        agent: Option<String>,
        steps: Vec<Step>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    #[test]
    fn replays_the_windows_title_rules() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/titleStatus.json");
        let fixture: Fixture = serde_json::from_str(raw).unwrap();
        assert!(fixture.cases.len() > 100);
        for (n, case) in fixture.cases.iter().enumerate() {
            let mut track = TitleTrack::default();
            for (i, step) in case.steps.iter().enumerate() {
                match step {
                    Step::Title { title, expected } => {
                        let got = change(track, case.agent.as_deref(), title);
                        assert_eq!(&got, expected, "case {n} step {i}: {title:?}");
                        track = got.track;
                    }
                    Step::Grace { expected, .. } => {
                        track = grace_ended(track);
                        assert_eq!(track, expected.track, "case {n} step {i}: grace");
                    }
                }
            }
        }
    }

    #[test]
    fn only_vibe_has_title_rules() {
        assert!(has_title_status("vibe"));
        assert!(!has_title_status("claude"));
        assert_eq!(read_title(None, ">> x"), None);
    }
}

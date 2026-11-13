//! **Agent handles** across a Profile (ADR-0055): the uniqueness check and
//! **Default handles** ("Agent One", "Agent Two" …).
//!
//! Both read every layout of the Profile from the database, because each
//! Window holds only a copy of the other Windows' layouts and that copy can be
//! stale. A default handle is also reserved here for a few seconds, until the
//! asking Window has written it into its layout, so two Windows naming two new
//! Agents at once never get the same number.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agent_control::{handle_key, normalize_handle};
use crate::error::AbundioError;
use crate::workspace_store::WorkspaceStore;

/// How long a handed-out default stays reserved without reaching a layout.
const RESERVATION: Duration = Duration::from_secs(10);

const ONES: [&str; 20] = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
    "Nineteen",
];
const TENS: [&str; 10] = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

/// `n` in words, as in a Default handle: One, Twenty-One, One Hundred Five.
pub fn number_words(n: u32) -> String {
    match n {
        0..=19 => ONES[n as usize].to_string(),
        20..=99 => {
            let tens = TENS[(n / 10) as usize];
            match n % 10 {
                0 => tens.to_string(),
                ones => format!("{tens}-{}", ONES[ones as usize]),
            }
        }
        100..=999 => {
            let rest = n % 100;
            let hundreds = format!("{} Hundred", ONES[(n / 100) as usize]);
            if rest == 0 {
                hundreds
            } else {
                format!("{hundreds} {}", number_words(rest))
            }
        }
        _ => n.to_string(),
    }
}

/// The Default handle with number `n`.
pub fn default_handle(n: u32) -> String {
    format!("Agent {}", number_words(n))
}

/// The lowest Default handle whose key is not in `taken`.
pub fn lowest_free(taken: &HashSet<String>) -> String {
    (1..)
        .map(default_handle)
        .find(|h| !taken.contains(&handle_key(h)))
        .expect("an unbounded range always has a free number")
}

struct Reserved {
    profile_id: String,
    pane_id: String,
    handle: String,
    /// Handed out by `take_default`, rather than held after a `check`.
    default: bool,
    at: Instant,
}

/// Handles handed out or approved but maybe not in a layout yet, by key: the
/// layout is written after the check, so without this two renames at once
/// could both pass.
#[derive(Default)]
pub struct HandleReservations(Mutex<HashMap<String, Reserved>>);

/// The answer to a handle check, shaped like the frontend's `HandleCheck`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum HandleCheck {
    Ok { ok: bool },
    Refused { ok: bool, code: &'static str, message: String },
}

impl HandleCheck {
    fn ok() -> Self {
        HandleCheck::Ok { ok: true }
    }
    fn refused(code: &'static str, message: String) -> Self {
        HandleCheck::Refused { ok: false, code, message }
    }
}

/// Handles in use in a Profile, by key → the Workspace name holding each,
/// leaving out `pane_id`'s own (a pane may keep or re-set its handle).
fn handles_in_use(
    store: &WorkspaceStore,
    profile_id: &str,
    pane_id: &str,
) -> Result<HashMap<String, String>, AbundioError> {
    Ok(store
        .profile_handles(profile_id)?
        .into_iter()
        .filter(|(_, _, pane, _)| pane != pane_id)
        .map(|(_, ws_name, _, h)| (handle_key(&h), ws_name))
        .collect())
}

impl HandleReservations {
    /// Reservations still alive for `profile_id`, by other panes than
    /// `pane_id`. Expired ones are dropped on the way.
    fn live_for(
        map: &mut HashMap<String, Reserved>,
        profile_id: &str,
        pane_id: &str,
    ) -> HashSet<String> {
        map.retain(|_, r| r.at.elapsed() < RESERVATION);
        map.iter()
            .filter(|(_, r)| r.profile_id == profile_id && r.pane_id != pane_id)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// May `pane_id` (in `workspace_id`) take `handle`?
    pub fn check(
        &self,
        store: &WorkspaceStore,
        workspace_id: &str,
        pane_id: &str,
        handle: &str,
    ) -> Result<HandleCheck, AbundioError> {
        let Some(name) = normalize_handle(handle) else {
            return Ok(HandleCheck::refused(
                "invalid_handle",
                format!("{handle:?} is not a valid Agent handle: up to 32 characters, starting with a letter, then letters, digits, spaces, '-' or '_', and not a Pane number"),
            ));
        };
        let Some(profile_id) = store.profile_of(workspace_id)? else {
            return Ok(HandleCheck::refused("not_found", "that Workspace no longer exists".into()));
        };
        let key = handle_key(&name);
        if let Some(ws) = handles_in_use(store, &profile_id, pane_id)?.get(&key) {
            return Ok(HandleCheck::refused(
                "handle_taken",
                format!("an Agent in the Workspace \"{ws}\" is already called \"{name}\""),
            ));
        }
        let mut map = self.0.lock().unwrap();
        if Self::live_for(&mut map, &profile_id, pane_id).contains(&key) {
            return Ok(HandleCheck::refused(
                "handle_taken",
                format!("\"{name}\" was just given to another Agent"),
            ));
        }
        // Hold it for this pane until its layout carries it.
        map.retain(|_, r| r.pane_id != pane_id);
        map.insert(
            key,
            Reserved {
                profile_id,
                pane_id: pane_id.to_string(),
                handle: name,
                default: false,
                at: Instant::now(),
            },
        );
        Ok(HandleCheck::ok())
    }

    /// The lowest free Default handle in the Profile of `workspace_id`,
    /// reserved for `pane_id`.
    pub fn take_default(
        &self,
        store: &WorkspaceStore,
        workspace_id: &str,
        pane_id: &str,
    ) -> Result<String, AbundioError> {
        let profile_id = store
            .profile_of(workspace_id)?
            .ok_or_else(|| AbundioError::NotFound(format!("Workspace not found: {workspace_id}")))?;
        // One lock around reading what is taken and reserving, so two asks
        // at once cannot both see the same number free.
        let mut map = self.0.lock().unwrap();
        // Asked again for the same pane (a retry): hand back what it holds.
        if let Some(r) = map
            .values()
            .find(|r| r.default && r.pane_id == pane_id && r.at.elapsed() < RESERVATION)
        {
            return Ok(r.handle.clone());
        }
        let mut taken: HashSet<String> =
            handles_in_use(store, &profile_id, pane_id)?.into_keys().collect();
        taken.extend(Self::live_for(&mut map, &profile_id, pane_id));
        let handle = lowest_free(&taken);
        map.retain(|_, r| r.pane_id != pane_id);
        map.insert(
            handle_key(&handle),
            Reserved {
                profile_id,
                pane_id: pane_id.to_string(),
                handle: handle.clone(),
                default: true,
                at: Instant::now(),
            },
        );
        Ok(handle)
    }
}

// ── Commands ──

#[tauri::command]
pub fn agent_handle_check(
    store: tauri::State<'_, WorkspaceStore>,
    reservations: tauri::State<'_, HandleReservations>,
    workspace_id: String,
    pane_id: String,
    handle: String,
) -> Result<HandleCheck, AbundioError> {
    reservations.check(&store, &workspace_id, &pane_id, &handle)
}

#[tauri::command]
pub fn agent_handle_default(
    store: tauri::State<'_, WorkspaceStore>,
    reservations: tauri::State<'_, HandleReservations>,
    workspace_id: String,
    pane_id: String,
) -> Result<String, AbundioError> {
    reservations.take_default(&store, &workspace_id, &pane_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_store::TabUpdate;
    use rusqlite::Connection;

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn store() -> WorkspaceStore {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        WorkspaceStore::new(conn)
    }

    /// A Workspace in `profile` whose first Tab holds terminal panes with
    /// these `(pane_id, handle)`s side by side.
    fn workspace(s: &WorkspaceStore, name: &str, profile: &str, panes: &[(&str, Option<&str>)]) -> String {
        let ws = s.create(name, "/tmp", profile).unwrap();
        let mut nodes: Vec<serde_json::Value> = panes
            .iter()
            .map(|(id, h)| {
                let mut n = serde_json::json!({ "type": "terminal", "id": id, "ptyId": "" });
                if let Some(h) = h {
                    n["agentHandle"] = serde_json::json!(h);
                }
                n
            })
            .collect();
        let mut tree = nodes.pop().unwrap();
        while let Some(n) = nodes.pop() {
            tree = serde_json::json!({ "type": "split", "id": "s", "direction": "vertical", "ratio": 0.5, "first": n, "second": tree });
        }
        s.update_tab(
            &ws.tabs[0].id,
            TabUpdate { layout_json: Some(tree.to_string()), ..Default::default() },
        )
        .unwrap();
        ws.workspace.id
    }

    fn other_profile(s: &WorkspaceStore) -> String {
        s.conn_for_tests()
            .execute(
                "INSERT INTO profiles (id, name, position) VALUES ('p2', 'Other', 1)",
                [],
            )
            .unwrap();
        "p2".into()
    }

    #[test]
    fn numbers_in_words() {
        let cases = [
            (1, "One"), (9, "Nine"), (12, "Twelve"), (19, "Nineteen"), (20, "Twenty"),
            (21, "Twenty-One"), (45, "Forty-Five"), (99, "Ninety-Nine"), (100, "One Hundred"),
            (105, "One Hundred Five"), (121, "One Hundred Twenty-One"), (999, "Nine Hundred Ninety-Nine"),
            (1000, "1000"),
        ];
        for (n, words) in cases {
            assert_eq!(number_words(n), words, "{n}");
        }
        assert_eq!(default_handle(2), "Agent Two");
        // Every default handle is a valid handle.
        for n in 1..300 {
            assert!(crate::agent_control::valid_handle(&default_handle(n)), "{n}");
        }
    }

    #[test]
    fn lowest_free_number_fills_gaps_and_skips_look_alikes() {
        let taken: HashSet<String> = ["agent-one", "agent-three"].map(String::from).into();
        assert_eq!(lowest_free(&taken), "Agent Two");
        // A user who typed "agent two" took Two as surely as a default did.
        let taken: HashSet<String> = ["agent-one", "agent-two"].map(String::from).into();
        assert_eq!(lowest_free(&taken), "Agent Three");
    }

    #[test]
    fn defaults_are_counted_across_the_profile() {
        let s = store();
        let r = HandleReservations::default();
        workspace(&s, "api", PID, &[("a1", Some("Agent One")), ("a2", Some("Reviewer"))]);
        let web = workspace(&s, "web", PID, &[("b1", Some("Agent Three")), ("b2", None)]);
        assert_eq!(r.take_default(&s, &web, "b2").unwrap(), "Agent Two");
        // Another Profile counts on its own.
        let p2 = other_profile(&s);
        let other = workspace(&s, "solo", &p2, &[("c1", None)]);
        assert_eq!(r.take_default(&s, &other, "c1").unwrap(), "Agent One");
    }

    #[test]
    fn a_reservation_keeps_two_new_agents_apart() {
        let s = store();
        let r = HandleReservations::default();
        let ws = workspace(&s, "api", PID, &[("a1", None), ("a2", None)]);
        // Neither layout carries its handle yet.
        assert_eq!(r.take_default(&s, &ws, "a1").unwrap(), "Agent One");
        assert_eq!(r.take_default(&s, &ws, "a2").unwrap(), "Agent Two");
        // Asking again for a1 does not hand out a third number.
        assert_eq!(r.take_default(&s, &ws, "a1").unwrap(), "Agent One");
        // And a check by another pane sees the reservation.
        assert!(matches!(
            r.check(&s, &ws, "a2", "agent one").unwrap(),
            HandleCheck::Refused { code: "handle_taken", .. }
        ));
    }

    #[test]
    fn a_number_is_free_again_once_its_agent_is_gone() {
        let s = store();
        let r = HandleReservations::default();
        let gone = workspace(&s, "old", PID, &[("a1", Some("Agent One"))]);
        let ws = workspace(&s, "api", PID, &[("a2", Some("Agent Two")), ("a3", None)]);
        // Agent One left: its Workspace (and so its layout) is gone.
        s.delete(&gone).unwrap();
        assert_eq!(r.take_default(&s, &ws, "a3").unwrap(), "Agent One");
    }

    #[test]
    fn check_is_profile_wide_and_by_key() {
        let s = store();
        let r = HandleReservations::default();
        workspace(&s, "api", PID, &[("a1", Some("Reviewer"))]);
        let web = workspace(&s, "web", PID, &[("b1", None)]);
        let HandleCheck::Refused { code, message, .. } = r.check(&s, &web, "b1", "reviewer").unwrap() else {
            panic!("taken in another Workspace of the Profile");
        };
        assert_eq!(code, "handle_taken");
        assert!(message.contains("\"api\""));
        assert_eq!(r.check(&s, &web, "b1", "Agent Seven").unwrap(), HandleCheck::ok());
        // A pane may re-set its own handle.
        let api_pane_ws = workspace(&s, "solo", PID, &[("c1", Some("Solo"))]);
        assert_eq!(r.check(&s, &api_pane_ws, "c1", "solo").unwrap(), HandleCheck::ok());
        // Grammar first.
        assert!(matches!(
            r.check(&s, &web, "b1", "p3").unwrap(),
            HandleCheck::Refused { code: "invalid_handle", .. }
        ));
        // Not across Profiles.
        let p2 = other_profile(&s);
        let other = workspace(&s, "x", &p2, &[("d1", None)]);
        assert_eq!(r.check(&s, &other, "d1", "Reviewer").unwrap(), HandleCheck::ok());
    }

    #[test]
    fn an_approved_name_is_held_until_its_layout_carries_it() {
        let s = store();
        let r = HandleReservations::default();
        let ws = workspace(&s, "api", PID, &[("a1", None), ("a2", None)]);
        // Two renames at once: the second is refused, though no layout has it yet.
        assert_eq!(r.check(&s, &ws, "a1", "Reviewer").unwrap(), HandleCheck::ok());
        assert!(matches!(
            r.check(&s, &ws, "a2", "reviewer").unwrap(),
            HandleCheck::Refused { code: "handle_taken", .. }
        ));
        // The same pane may check it again, or pick another name, which frees the first.
        assert_eq!(r.check(&s, &ws, "a1", "Reviewer").unwrap(), HandleCheck::ok());
        assert_eq!(r.check(&s, &ws, "a1", "Writer").unwrap(), HandleCheck::ok());
        assert_eq!(r.check(&s, &ws, "a2", "Reviewer").unwrap(), HandleCheck::ok());
        // A held name is never handed back as the pane's default.
        assert_eq!(r.take_default(&s, &ws, "a1").unwrap(), "Agent One");
    }

    #[test]
    fn answers_serialise_like_the_frontend_expects() {
        assert_eq!(serde_json::to_value(HandleCheck::ok()).unwrap(), serde_json::json!({ "ok": true }));
        let v = serde_json::to_value(HandleCheck::refused("handle_taken", "x".into())).unwrap();
        assert_eq!(v, serde_json::json!({ "ok": false, "code": "handle_taken", "message": "x" }));
    }
}

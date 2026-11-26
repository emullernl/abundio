//! **Agent handles** across a Profile (ADR-0055): the uniqueness check and
//! **Default handles** ("Claude 1", "Codex 2" …): a **Handle prefix** and the
//! lowest number free for it. Handles from before ("Agent One") are kept.
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

use crate::control_protocol::{handle_key, normalize_handle};
use crate::error::AbundioError;
use crate::workspace_store::WorkspaceStore;


/// How long a handed-out default stays reserved without reaching a layout.
const RESERVATION: Duration = Duration::from_secs(10);

/// The handle of every Profile's Orchestrator (ADR-0057). No other Agent may
/// take it.
pub const ORCHESTRATOR_HANDLE: &str = "Orchestrator";

/// The prefix of a Default handle whose Agent is not known.
pub const FALLBACK_PREFIX: &str = "Agent";

/// Room left in a 32-character handle for " " and a number up to 99999.
const PREFIX_MAX_LENGTH: usize = 26;

/// The **Handle prefix** to use for `asked` (what the Window sent): one word,
/// starting with a letter, else "Agent". The Window's `handlePrefix.ts`
/// applies the same rule.
pub fn handle_prefix(asked: Option<&str>) -> &str {
    match asked.map(str::trim) {
        Some(p)
            if !p.is_empty()
                && p.len() <= PREFIX_MAX_LENGTH
                && p.starts_with(|c: char| c.is_ascii_alphabetic())
                && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            p
        }
        _ => FALLBACK_PREFIX,
    }
}

/// The Default handle for `prefix` with number `n`: "Claude 3".
pub fn default_handle(prefix: &str, n: u32) -> String {
    format!("{prefix} {n}")
}

/// The lowest Default handle for `prefix` whose key is not in `taken`.
pub fn lowest_free(prefix: &str, taken: &HashSet<String>) -> String {
    (1..)
        .map(|n| default_handle(prefix, n))
        .find(|h| !taken.contains(&handle_key(h)))
        .expect("an unbounded range always has a free number")
}

/// Whether `handle` is a Default handle for `prefix` ("Claude 3").
fn is_default_for(prefix: &str, handle: &str) -> bool {
    let key = handle_key(handle);
    key.strip_prefix(&format!("{}-", handle_key(prefix)))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
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
        // Reserved for the Profile's Orchestrator (ADR-0057), so every Agent
        // and the user can always reach it by that name.
        if key == handle_key(ORCHESTRATOR_HANDLE)
            && store.kind_of(workspace_id)?.as_deref() != Some("orchestrator")
        {
            return Ok(HandleCheck::refused(
                "handle_taken",
                format!("\"{name}\" is kept for the Orchestrator"),
            ));
        }
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

    /// The lowest free Default handle for `prefix` (a **Handle prefix**,
    /// checked by `handle_prefix`) in the Profile of `workspace_id`, reserved
    /// for `pane_id`.
    pub fn take_default(
        &self,
        store: &WorkspaceStore,
        workspace_id: &str,
        pane_id: &str,
        prefix: Option<&str>,
    ) -> Result<String, AbundioError> {
        let prefix = handle_prefix(prefix);
        let profile_id = store
            .profile_of(workspace_id)?
            .ok_or_else(|| AbundioError::NotFound(format!("Workspace not found: {workspace_id}")))?;
        // One lock around reading what is taken and reserving, so two asks
        // at once cannot both see the same number free.
        let mut map = self.0.lock().unwrap();
        // Asked again for the same pane (a retry): hand back what it holds,
        // unless it was for another prefix (its Agent has become known).
        if let Some(r) = map.values().find(|r| {
            r.default
                && r.pane_id == pane_id
                && r.at.elapsed() < RESERVATION
                && is_default_for(prefix, &r.handle)
        }) {
            return Ok(r.handle.clone());
        }
        let mut taken: HashSet<String> =
            handles_in_use(store, &profile_id, pane_id)?.into_keys().collect();
        taken.extend(Self::live_for(&mut map, &profile_id, pane_id));
        let handle = lowest_free(prefix, &taken);
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
    fn orchestrator_is_kept_for_the_orchestrator_workspace() {
        let s = store();
        let r = HandleReservations::default();
        let work = workspace(&s, "w", PID, &[("a", None)]);
        let orch = s.ensure_orchestrator(PID, "/o").unwrap().workspace.id;
        for name in ["Orchestrator", "orchestrator", " ORCHESTRATOR "] {
            assert!(
                matches!(r.check(&s, &work, "a", name).unwrap(), HandleCheck::Refused { code: "handle_taken", .. }),
                "{name}"
            );
        }
        assert_eq!(r.check(&s, &orch, "o", "Orchestrator").unwrap(), HandleCheck::ok());
    }

    #[test]
    fn prefixes_are_one_word_or_agent() {
        assert_eq!(handle_prefix(Some("Claude")), "Claude");
        assert_eq!(handle_prefix(Some(" Codex ")), "Codex");
        for bad in [None, Some(""), Some("9lives"), Some("Two words"), Some("ab!"), Some(&"x".repeat(27))] {
            assert_eq!(handle_prefix(bad), "Agent", "{bad:?}");
        }
        assert_eq!(default_handle("Claude", 2), "Claude 2");
        // Every default handle is a valid handle, even at the longest prefix.
        let long = "x".repeat(26);
        for n in [1, 99, 100, 99_999] {
            assert!(crate::control_protocol::valid_handle(&default_handle(&long, n)), "{n}");
            assert!(crate::control_protocol::valid_handle(&default_handle("Agent", n)), "{n}");
        }
    }

    #[test]
    fn lowest_free_number_fills_gaps_per_prefix() {
        let taken: HashSet<String> = ["claude-1", "claude-3", "codex-2"].map(String::from).into();
        assert_eq!(lowest_free("Claude", &taken), "Claude 2");
        assert_eq!(lowest_free("Codex", &taken), "Codex 1");
        // An older "Agent One" does not take "Agent 1".
        let taken: HashSet<String> = ["agent-one"].map(String::from).into();
        assert_eq!(lowest_free("Agent", &taken), "Agent 1");
        assert!(is_default_for("Claude", "claude 12"));
        assert!(!is_default_for("Claude", "Claude"));
        assert!(!is_default_for("Claude", "Claude x"));
        assert!(!is_default_for("Agent", "Agent One"));
    }

    #[test]
    fn defaults_are_counted_across_the_profile() {
        let s = store();
        let r = HandleReservations::default();
        workspace(&s, "api", PID, &[("a1", Some("Claude 1")), ("a2", Some("Reviewer"))]);
        let web = workspace(&s, "web", PID, &[("b1", Some("Claude 3")), ("b2", None)]);
        assert_eq!(r.take_default(&s, &web, "b2", Some("Claude")).unwrap(), "Claude 2");
        // Each prefix counts on its own.
        let r = HandleReservations::default();
        assert_eq!(r.take_default(&s, &web, "b2", Some("Codex")).unwrap(), "Codex 1");
        // Another Profile counts on its own.
        let p2 = other_profile(&s);
        let other = workspace(&s, "solo", &p2, &[("c1", None)]);
        assert_eq!(r.take_default(&s, &other, "c1", Some("Claude")).unwrap(), "Claude 1");
    }

    #[test]
    fn a_reservation_keeps_two_new_agents_apart() {
        let s = store();
        let r = HandleReservations::default();
        let ws = workspace(&s, "api", PID, &[("a1", None), ("a2", None)]);
        // Neither layout carries its handle yet.
        assert_eq!(r.take_default(&s, &ws, "a1", Some("Claude")).unwrap(), "Claude 1");
        assert_eq!(r.take_default(&s, &ws, "a2", Some("Claude")).unwrap(), "Claude 2");
        // Asking again for a1 does not hand out a third number.
        assert_eq!(r.take_default(&s, &ws, "a1", Some("Claude")).unwrap(), "Claude 1");
        // And a check by another pane sees the reservation.
        assert!(matches!(
            r.check(&s, &ws, "a2", "claude 1").unwrap(),
            HandleCheck::Refused { code: "handle_taken", .. }
        ));
    }

    #[test]
    fn a_number_is_free_again_once_its_agent_is_gone() {
        let s = store();
        let r = HandleReservations::default();
        let gone = workspace(&s, "old", PID, &[("a1", Some("Claude 1"))]);
        let ws = workspace(&s, "api", PID, &[("a2", Some("Claude 2")), ("a3", None)]);
        // Claude 1 left: its Workspace (and so its layout) is gone.
        s.delete(&gone).unwrap();
        assert_eq!(r.take_default(&s, &ws, "a3", Some("Claude")).unwrap(), "Claude 1");
    }

    #[test]
    fn a_pane_whose_agent_becomes_known_gets_a_new_default() {
        let s = store();
        let r = HandleReservations::default();
        let ws = workspace(&s, "api", PID, &[("a1", None)]);
        assert_eq!(r.take_default(&s, &ws, "a1", None).unwrap(), "Agent 1");
        // Still reserved, but for "Agent": the Claude one is a new number.
        assert_eq!(r.take_default(&s, &ws, "a1", Some("Claude")).unwrap(), "Claude 1");
        // And "Agent 1" is free again for another pane.
        assert_eq!(r.take_default(&s, &ws, "a2", None).unwrap(), "Agent 1");
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
        assert_eq!(r.take_default(&s, &ws, "a1", None).unwrap(), "Agent 1");
    }

    #[test]
    fn answers_serialise_like_the_frontend_expects() {
        assert_eq!(serde_json::to_value(HandleCheck::ok()).unwrap(), serde_json::json!({ "ok": true }));
        let v = serde_json::to_value(HandleCheck::refused("handle_taken", "x".into())).unwrap();
        assert_eq!(v, serde_json::json!({ "ok": false, "code": "handle_taken", "message": "x" }));
    }
}

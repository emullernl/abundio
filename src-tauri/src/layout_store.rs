//! Every Tab's layout as Rust holds it: the authority (ADR-0063,
//! docs/plans/remote-hosts.md phase 4). A Window sends its edits as ops
//! (`layout_ops.rs`); this applies them to its own copy, saves the result,
//! numbers it, and has it sent to every other Window of the Profile.
//!
//! The Window still **predicts**: it shows its own edit at once and takes
//! Rust's answer only when it differs (another Client's edit got there
//! first, or an op named a pane that was gone).
//!
//! Versions live in memory, per Tab, from 1 each time the backend starts:
//! they order one run's edits, nothing more, so there is no migration.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::error::AbundioError;
use crate::event_sink::ClientId;
use crate::layout_ops::{self, LayoutOp};
use crate::workspace_store::WorkspaceStore;

struct Entry {
    layout: Value,
    version: u64,
    profile_id: String,
}

/// A Tab's layout as it now stands (`LayoutState` in `layoutSync.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    pub tab_id: String,
    pub version: u64,
    pub layout_json: String,
    /// Whether the ops were applied. `false`: an op named a pane that is not
    /// there, and the layout is unchanged; `reason` says why.
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What one `apply` did, for the caller to send on.
pub struct Applied {
    pub state: LayoutState,
    pub profile_id: String,
    /// Whether the layout changed (and so was saved and must be broadcast).
    pub changed: bool,
}

#[derive(Default)]
pub struct LayoutStore {
    tabs: Mutex<HashMap<String, Entry>>,
}

/// `tree` with every terminal's `ptyId` emptied unless that PTY is running.
/// A stored layout remembers the PTYs of the run that saved it; those died
/// with it, and the Window clears them on load too.
fn clear_dead_ptys(tree: &mut Value, is_live: &dyn Fn(&str) -> bool) {
    match tree.get("type").and_then(Value::as_str) {
        Some("terminal") => {
            let dead = tree
                .get("ptyId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && !is_live(id));
            if dead {
                tree["ptyId"] = Value::String(String::new());
            }
        }
        Some("split") => {
            for side in ["first", "second"] {
                if let Some(child) = tree.get_mut(side) {
                    clear_dead_ptys(child, is_live);
                }
            }
        }
        _ => {}
    }
}

impl LayoutStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply `ops` to the Tab's layout, all or nothing, and save it.
    pub fn apply(
        &self,
        db: &WorkspaceStore,
        tab_id: &str,
        ops: &[LayoutOp],
        is_live: &dyn Fn(&str) -> bool,
    ) -> Result<Applied, AbundioError> {
        // One lock over apply and save, so the database sees edits in the
        // order they are numbered.
        let mut tabs = self.tabs.lock().unwrap();
        if !tabs.contains_key(tab_id) {
            let (json, profile_id) = db
                .tab_layout(tab_id)?
                .ok_or_else(|| AbundioError::NotFound(format!("Tab not found: {tab_id}")))?;
            let mut layout = serde_json::from_str(&json).unwrap_or(Value::Null);
            clear_dead_ptys(&mut layout, is_live);
            tabs.insert(tab_id.to_string(), Entry { layout, version: 1, profile_id });
        }
        let entry = tabs.get_mut(tab_id).expect("inserted above");
        let state = |e: &Entry, applied: bool, reason: Option<String>| LayoutState {
            tab_id: tab_id.to_string(),
            version: e.version,
            layout_json: e.layout.to_string(),
            applied,
            reason,
        };
        let next = match layout_ops::apply(&entry.layout, ops) {
            Ok(next) => next,
            Err(e) => {
                return Ok(Applied {
                    state: state(entry, false, Some(e.to_string())),
                    profile_id: entry.profile_id.clone(),
                    changed: false,
                })
            }
        };
        if next == entry.layout {
            return Ok(Applied {
                state: state(entry, true, None),
                profile_id: entry.profile_id.clone(),
                changed: false,
            });
        }
        if !db.set_tab_layout(tab_id, &next.to_string())? {
            tabs.remove(tab_id);
            return Err(AbundioError::NotFound(format!("Tab not found: {tab_id}")));
        }
        entry.layout = next;
        entry.version += 1;
        Ok(Applied {
            state: state(entry, true, None),
            profile_id: entry.profile_id.clone(),
            changed: true,
        })
    }

    /// Drop a Tab: it was deleted, or its layout was written past this store
    /// (`tab_update`), so the next edit reads it afresh.
    pub fn forget(&self, tab_id: &str) {
        self.tabs.lock().unwrap().remove(tab_id);
    }
}

/// The Windows to tell of a change to a Profile's layout: every Window
/// showing that Profile except the one that made it.
pub fn broadcast_targets(
    windows: &HashMap<String, String>,
    profile_id: &str,
    origin: &ClientId,
) -> Vec<ClientId> {
    let mut out: Vec<ClientId> = windows
        .iter()
        .filter(|(label, p)| p.as_str() == profile_id && label.as_str() != origin.as_str())
        .map(|(label, _)| ClientId(label.clone()))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn db() -> (WorkspaceStore, String) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        let store = WorkspaceStore::new(conn);
        let ws = store.create("w", "/tmp", PID).unwrap();
        let tab = ws.tabs[0].id.clone();
        let layout = json!({
            "type": "split", "id": "s", "direction": "vertical", "ratio": 0.5,
            "first": { "type": "terminal", "id": "a", "ptyId": "old-pty" },
            "second": { "type": "terminal", "id": "b", "ptyId": "live-pty" }
        });
        assert!(store.set_tab_layout(&tab, &layout.to_string()).unwrap());
        (store, tab)
    }

    fn live(id: &str) -> bool {
        id == "live-pty"
    }

    fn cwd(id: &str, path: &str) -> LayoutOp {
        LayoutOp::Patch {
            id: id.into(),
            set: json!({ "cwd": path }).as_object().unwrap().clone(),
            unset: vec![],
        }
    }

    fn stored(db: &WorkspaceStore, tab: &str) -> Value {
        serde_json::from_str(&db.tab_layout(tab).unwrap().unwrap().0).unwrap()
    }

    #[test]
    fn applies_saves_and_numbers_each_edit() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        let a = store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        assert!(a.changed && a.state.applied);
        assert_eq!(a.state.version, 2);
        assert_eq!(a.profile_id, PID);
        assert_eq!(stored(&db, &tab)["first"]["cwd"], "/x");
        let b = store.apply(&db, &tab, &[cwd("b", "/y")], &live).unwrap();
        assert_eq!(b.state.version, 3);
        let both: Value = serde_json::from_str(&b.state.layout_json).unwrap();
        assert_eq!(both["first"]["cwd"], "/x");
        assert_eq!(both["second"]["cwd"], "/y");
    }

    #[test]
    fn forgets_the_ptys_of_an_earlier_run_when_it_first_reads_a_tab() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        let a = store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        let v: Value = serde_json::from_str(&a.state.layout_json).unwrap();
        assert_eq!(v["first"]["ptyId"], "");
        assert_eq!(v["second"]["ptyId"], "live-pty");
    }

    #[test]
    fn an_edit_that_changes_nothing_is_not_saved_or_sent() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        let again = store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        assert!(!again.changed && again.state.applied);
        assert_eq!(again.state.version, 2);
    }

    #[test]
    fn a_batch_naming_a_gone_pane_answers_with_the_layout_as_it_stands() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        let r = store.apply(&db, &tab, &[cwd("b", "/y"), cwd("gone", "/z")], &live).unwrap();
        assert!(!r.state.applied && !r.changed);
        assert!(r.state.reason.unwrap().contains("gone"));
        let v: Value = serde_json::from_str(&r.state.layout_json).unwrap();
        assert!(v["second"].get("cwd").is_none());
        assert_eq!(stored(&db, &tab)["first"]["cwd"], "/x");
    }

    #[test]
    fn a_deleted_tab_is_not_found() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        db.delete_tab(&tab).unwrap();
        assert!(store.apply(&db, &tab, &[cwd("a", "/y")], &live).is_err());
        store.forget(&tab);
        assert!(store.apply(&db, &tab, &[cwd("a", "/y")], &live).is_err());
    }

    #[test]
    fn rereads_a_tab_written_past_it() {
        let (db, tab) = db();
        let store = LayoutStore::new();
        store.apply(&db, &tab, &[cwd("a", "/x")], &live).unwrap();
        db.set_tab_layout(&tab, r#"{"type":"terminal","id":"n","ptyId":""}"#).unwrap();
        store.forget(&tab);
        let r = store.apply(&db, &tab, &[cwd("n", "/q")], &live).unwrap();
        assert!(r.state.applied);
        assert_eq!(r.state.version, 2);
    }

    #[test]
    fn tells_every_other_window_of_the_profile() {
        let windows: HashMap<String, String> = [
            ("window-a", PID),
            ("window-b", PID),
            ("window-c", "other"),
        ]
        .into_iter()
        .map(|(l, p)| (l.to_string(), p.to_string()))
        .collect();
        assert_eq!(
            broadcast_targets(&windows, PID, &ClientId::from("window-a")),
            vec![ClientId::from("window-b")]
        );
    }
}

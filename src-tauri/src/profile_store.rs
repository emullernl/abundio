use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::AbundioError;

/// Well-known UUID for the "Default" profile created at migration time. Used by
/// the migration's `ALTER TABLE ... DEFAULT` clause to backfill existing
/// workspaces, and exposed here so Rust code can refer to it without a DB lookup.
pub const DEFAULT_PROFILE_ID: &str = "00000000-0000-0000-0000-000000000001";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdate {
    pub name: Option<String>,
}

pub struct ProfileStore {
    pub conn: Mutex<Connection>,
}

/// Tracks which Profile each open Window is showing. The map is keyed by the
/// Tauri window label and contains exactly one entry per open Window. A
/// Profile id appears in at most one entry — see ADR-0007.
///
/// The frontend pushes its window's active profile via `set_active_profile_id`
/// during startup and on every in-window switch. The Rust side reads the map
/// when rebuilding the native menu (to render checkmarks and the
/// "open-elsewhere" dimming) and when enforcing the strict-delete invariant.
#[derive(Default)]
pub struct ActiveProfileState(pub Mutex<HashMap<String, String>>);

/// Flag set by the `RunEvent::ExitRequested` handler so subsequent window
/// `Destroyed` events know we're in the middle of an app-level quit and
/// should NOT save individual window removals to `windows.json` — the quit
/// handler already snapshotted the full pre-quit state. See ADR-0007 and
/// `lib.rs` for the full flow.
#[derive(Default)]
pub struct QuittingFlag(pub Mutex<bool>);

/// Tracks how many **Opened workspaces** each Window currently has live, keyed
/// by the Tauri window label. The frontend pushes its window's count via
/// `report_opened_workspace_count` whenever its `openedWorkspaceIds` set
/// changes, and the `Destroyed` handler drops the entry when a window closes.
///
/// Rust reads the sum at quit time to decide whether to show the
/// "you have N opened workspaces" confirmation — the count lives in each
/// window's frontend, so this map is the only place a cross-window total can be
/// computed. See ADR-0016.
#[derive(Default)]
pub struct OpenedCountState(pub Mutex<HashMap<String, usize>>);

/// Guards against stacking multiple quit-confirmation dialogs. The native quit
/// dialog is non-blocking (`show` returns immediately and the menu handler
/// returns), so a second Cmd+Q while the first dialog is still open would
/// otherwise re-enter the quit-app branch and open a second dialog on top. Set
/// before showing the dialog, cleared in its callback on both the confirm and
/// cancel paths. See ADR-0016.
#[derive(Default)]
pub struct QuitConfirmInFlight(pub Mutex<bool>);

impl OpenedCountState {
    /// Records the Opened-workspace count for the given Window.
    pub fn set_for_window(&self, window_label: &str, count: usize) {
        self.0
            .lock()
            .unwrap()
            .insert(window_label.to_string(), count);
    }

    /// Drops the entry for a Window (called when it's destroyed) so its stale
    /// count can't inflate the quit-time total.
    pub fn remove_for_window(&self, window_label: &str) {
        self.0.lock().unwrap().remove(window_label);
    }

    /// Total Opened workspaces across all Windows.
    pub fn total(&self) -> usize {
        self.0.lock().unwrap().values().sum()
    }
}

impl ActiveProfileState {
    /// The Profile id currently shown in the given Window, if any.
    pub fn get_for_window(&self, window_label: &str) -> Option<String> {
        self.0.lock().unwrap().get(window_label).cloned()
    }

    /// Sets the Profile id for the given Window. Returns the previous value.
    pub fn set_for_window(&self, window_label: &str, profile_id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .insert(window_label.to_string(), profile_id.to_string())
    }

    /// Removes the entry for the given Window (called when a window is closed).
    pub fn remove_for_window(&self, window_label: &str) -> Option<String> {
        self.0.lock().unwrap().remove(window_label)
    }

    /// Atomically claims `profile_id` for `window_label`. Returns `None` on a
    /// successful claim (the window now owns the profile), or `Some(owner)` if a
    /// *different* window already owns it (claim refused, nothing mutated).
    ///
    /// Folding the owner-check and the insert under one lock closes the TOCTOU
    /// window where two concurrent callers (e.g. two restoration paths, or a
    /// fast double-click) could both pass a separate `owner_of_profile` check
    /// and then both `set_for_window`, ending in two windows that briefly think
    /// they own the same profile. See PR #94 review.
    pub fn try_claim(&self, window_label: &str, profile_id: &str) -> Option<String> {
        let mut map = self.0.lock().unwrap();
        if let Some(owner) = map.iter().find_map(|(label, pid)| {
            (pid == profile_id && label != window_label).then(|| label.clone())
        }) {
            return Some(owner);
        }
        map.insert(window_label.to_string(), profile_id.to_string());
        None
    }

    /// Returns the window label currently showing `profile_id`, if any.
    /// Used by the strict-delete check and the "open elsewhere" menu dimming.
    pub fn owner_of_profile(&self, profile_id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find_map(|(label, pid)| (pid == profile_id).then(|| label.clone()))
    }

    /// Snapshot of the current ownership map. Returned as plain pairs so
    /// callers don't have to hold the mutex.
    pub fn snapshot(&self) -> HashMap<String, String> {
        self.0.lock().unwrap().clone()
    }
}

impl ProfileStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    pub fn create(&self, name: &str) -> Result<Profile, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM profiles",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO profiles (id, name, position) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, name, position],
        )?;
        Self::get_with_conn(&conn, &id)
    }

    pub fn list(&self) -> Result<Vec<Profile>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, position, created_at, updated_at
             FROM profiles ORDER BY position ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Profile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn update(&self, id: &str, updates: ProfileUpdate) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        if let Some(ref name) = updates.name {
            conn.execute(
                "UPDATE profiles SET name = ?1, updated_at = unixepoch() WHERE id = ?2",
                rusqlite::params![name, id],
            )?;
        }
        Ok(())
    }

    /// Deletes a profile. Enforces the "at least one profile must exist" invariant.
    /// Cascades to workspaces (and their tabs) via the FK ON DELETE CASCADE.
    pub fn delete(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        // Guard the "at least one profile must exist" invariant atomically: the
        // COUNT subquery and the DELETE evaluate under a single statement-level
        // write lock, so a concurrent delete on another connection (ProfileStore
        // and WorkspaceStore hold separate connections) cannot drive the count to
        // 1 between a separate check and delete and let us remove the last
        // profile. See PR #94 review.
        let affected = conn.execute(
            "DELETE FROM profiles WHERE id = ?1 AND (SELECT COUNT(*) FROM profiles) > 1",
            [id],
        )?;
        if affected == 0 {
            // Nothing deleted: either the id doesn't exist (idempotent no-op,
            // matching the prior behaviour) or it's the only profile left.
            // Distinguish so the invariant violation is surfaced as an error.
            let still_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
                [id],
                |r| r.get(0),
            )?;
            if still_exists {
                return Err(AbundioError::InvalidOperation(
                    "Cannot delete the only remaining profile".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE profiles SET position = ?1 WHERE id = ?2",
                rusqlite::params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn get_with_conn(conn: &Connection, id: &str) -> Result<Profile, AbundioError> {
        conn.query_row(
            "SELECT id, name, position, created_at, updated_at FROM profiles WHERE id = ?1",
            [id],
            |row| {
                Ok(Profile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AbundioError::NotFound(format!("Profile not found: {}", id))
            }
            other => AbundioError::Db(other),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> ProfileStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        ProfileStore::new(conn)
    }

    #[test]
    fn list_includes_default_profile_after_migration() {
        let store = test_store();
        let profiles = store.list().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Default");
        assert_eq!(profiles[0].id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn create_appends_in_position_order() {
        let store = test_store();
        let p = store.create("Work").unwrap();
        assert_eq!(p.position, 1);
        let p2 = store.create("Personal").unwrap();
        assert_eq!(p2.position, 2);
        let list = store.list().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "Default");
        assert_eq!(list[1].name, "Work");
        assert_eq!(list[2].name, "Personal");
    }

    #[test]
    fn update_renames_profile() {
        let store = test_store();
        let p = store.create("Wrok").unwrap();
        store
            .update(
                &p.id,
                ProfileUpdate {
                    name: Some("Work".into()),
                },
            )
            .unwrap();
        let list = store.list().unwrap();
        assert!(list.iter().any(|p| p.name == "Work"));
    }

    #[test]
    fn delete_only_profile_is_rejected() {
        let store = test_store();
        let result = store.delete(DEFAULT_PROFILE_ID);
        assert!(matches!(result, Err(AbundioError::InvalidOperation(_))));
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn delete_with_others_succeeds() {
        let store = test_store();
        let p = store.create("Work").unwrap();
        store.delete(DEFAULT_PROFILE_ID).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, p.id);
    }

    #[test]
    fn active_profile_state_per_window_isolation() {
        let state = ActiveProfileState::default();
        assert_eq!(state.get_for_window("main"), None);
        state.set_for_window("main", "p1");
        state.set_for_window("window-2", "p2");
        assert_eq!(state.get_for_window("main").as_deref(), Some("p1"));
        assert_eq!(state.get_for_window("window-2").as_deref(), Some("p2"));
        assert_eq!(state.get_for_window("window-3"), None);
    }

    #[test]
    fn try_claim_is_atomic_check_and_set() {
        let state = ActiveProfileState::default();
        // First claim succeeds and records ownership.
        assert_eq!(state.try_claim("window-1", "p1"), None);
        assert_eq!(state.get_for_window("window-1").as_deref(), Some("p1"));
        // A different window claiming the same profile is refused with the owner.
        assert_eq!(
            state.try_claim("window-2", "p1").as_deref(),
            Some("window-1")
        );
        // window-2 didn't get an entry from the refused claim.
        assert_eq!(state.get_for_window("window-2"), None);
        // The same window re-claiming its own profile is a no-op success.
        assert_eq!(state.try_claim("window-1", "p1"), None);
        // A distinct profile claims fine.
        assert_eq!(state.try_claim("window-2", "p2"), None);
    }

    #[test]
    fn active_profile_state_owner_lookup() {
        let state = ActiveProfileState::default();
        state.set_for_window("main", "p1");
        state.set_for_window("window-2", "p2");
        assert_eq!(state.owner_of_profile("p1").as_deref(), Some("main"));
        assert_eq!(state.owner_of_profile("p2").as_deref(), Some("window-2"));
        assert_eq!(state.owner_of_profile("p-unknown"), None);
    }

    #[test]
    fn quitting_flag_starts_false_and_toggles() {
        let flag = QuittingFlag::default();
        assert!(!*flag.0.lock().unwrap());
        *flag.0.lock().unwrap() = true;
        assert!(*flag.0.lock().unwrap());
    }

    #[test]
    fn opened_count_state_sums_across_windows() {
        let state = OpenedCountState::default();
        assert_eq!(state.total(), 0);
        state.set_for_window("main", 1);
        state.set_for_window("window-2", 3);
        assert_eq!(state.total(), 4);
        // A re-report replaces (not accumulates) the window's count.
        state.set_for_window("main", 2);
        assert_eq!(state.total(), 5);
        // Removing a window drops its contribution so a stale count can't
        // inflate the quit-time total.
        state.remove_for_window("window-2");
        assert_eq!(state.total(), 2);
        state.remove_for_window("main");
        assert_eq!(state.total(), 0);
    }

    #[test]
    fn active_profile_state_remove_releases_ownership() {
        let state = ActiveProfileState::default();
        state.set_for_window("main", "p1");
        state.remove_for_window("main");
        assert_eq!(state.owner_of_profile("p1"), None);
        assert_eq!(state.get_for_window("main"), None);
    }

    #[test]
    fn reorder_updates_positions() {
        let store = test_store();
        let work = store.create("Work").unwrap();
        let personal = store.create("Personal").unwrap();
        store
            .reorder(&[
                personal.id.clone(),
                work.id.clone(),
                DEFAULT_PROFILE_ID.to_string(),
            ])
            .unwrap();
        let list = store.list().unwrap();
        assert_eq!(list[0].id, personal.id);
        assert_eq!(list[1].id, work.id);
        assert_eq!(list[2].id, DEFAULT_PROFILE_ID);
    }
}

//! **Joined profiles** (docs/plans/remote-hosts.md phase 10, GLOSSARY.md):
//! the Remote profiles a local Profile shows in its Window, kept in the
//! desktop app's database. Joining only changes what the Window shows; the
//! Joined profile's Workspaces, handles and Agent control stay on its Host.
//!
//! Each row keeps the last Workspace list the Host gave, so a section can
//! still show its rows, greyed, while the Host cannot be reached.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AbundioError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedProfile {
    pub host_id: String,
    pub remote_profile_id: String,
    pub remote_profile_name: String,
    /// The Workspaces as the Host last listed them (JSON, as `workspace_list`
    /// answered).
    pub workspaces_json: String,
    /// When that was (ms since the epoch), if ever.
    pub last_seen_ms: Option<i64>,
}

/// The Profiles `profile_id` joined, in the order they were joined.
pub fn list(conn: &Connection, profile_id: &str) -> Result<Vec<JoinedProfile>, AbundioError> {
    let mut stmt = conn.prepare(
        "SELECT host_id, remote_profile_id, remote_profile_name, workspaces_json, last_seen_ms
         FROM joined_profiles WHERE profile_id = ?1 ORDER BY position, host_id",
    )?;
    let rows = stmt.query_map(params![profile_id], |r| {
        Ok(JoinedProfile {
            host_id: r.get(0)?,
            remote_profile_id: r.get(1)?,
            remote_profile_name: r.get(2)?,
            workspaces_json: r.get(3)?,
            last_seen_ms: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Join a Remote profile into `profile_id`. One per Host: a Window is one
/// Client on a Host, and a Client shows one Profile there.
pub fn add(
    conn: &Connection,
    profile_id: &str,
    host_id: &str,
    remote_profile_id: &str,
    remote_profile_name: &str,
) -> Result<(), AbundioError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT remote_profile_name FROM joined_profiles WHERE profile_id = ?1 AND host_id = ?2",
            params![profile_id, host_id],
            |r| r.get(0),
        )
        .ok();
    if let Some(name) = existing {
        return Err(AbundioError::InvalidOperation(format!(
            "this Profile already shows {name} from that Host; Leave it first to join another"
        )));
    }
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM joined_profiles WHERE profile_id = ?1",
        params![profile_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO joined_profiles (profile_id, host_id, remote_profile_id, remote_profile_name, position)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![profile_id, host_id, remote_profile_id, remote_profile_name, position],
    )?;
    Ok(())
}

/// Leave: the Profile no longer shows it. Nothing changes on the Host.
pub fn remove(conn: &Connection, profile_id: &str, host_id: &str) -> Result<(), AbundioError> {
    conn.execute(
        "DELETE FROM joined_profiles WHERE profile_id = ?1 AND host_id = ?2",
        params![profile_id, host_id],
    )?;
    Ok(())
}

/// The Host listed the Workspaces just now: keep them for when it is not
/// reachable, with the Profile's name as it is now.
pub fn seen(
    conn: &Connection,
    profile_id: &str,
    host_id: &str,
    remote_profile_name: &str,
    workspaces_json: &str,
    now_ms: i64,
) -> Result<(), AbundioError> {
    conn.execute(
        "UPDATE joined_profiles SET workspaces_json = ?3, last_seen_ms = ?4, remote_profile_name = ?5
         WHERE profile_id = ?1 AND host_id = ?2",
        params![profile_id, host_id, workspaces_json, now_ms, remote_profile_name],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        conn.execute("INSERT INTO profiles (id, name) VALUES ('local', 'Work')", []).unwrap();
        conn
    }

    #[test]
    fn joins_one_profile_per_host_remembers_its_rows_and_leaves() {
        let conn = db();
        add(&conn, "local", "box", "r1", "Build").unwrap();
        add(&conn, "local", "lab", "r2", "Lab").unwrap();
        let again = add(&conn, "local", "box", "r3", "Other").unwrap_err();
        assert!(again.to_string().contains("already shows Build"), "{again}");
        let l = list(&conn, "local").unwrap();
        assert_eq!(l.iter().map(|j| j.host_id.as_str()).collect::<Vec<_>>(), ["box", "lab"]);
        assert_eq!((l[0].workspaces_json.as_str(), l[0].last_seen_ms), ("[]", None));
        seen(&conn, "local", "box", "Build box", "[{\"id\":\"w\"}]", 42).unwrap();
        let j = &list(&conn, "local").unwrap()[0];
        assert_eq!((j.remote_profile_name.as_str(), j.last_seen_ms), ("Build box", Some(42)));
        remove(&conn, "local", "box").unwrap();
        assert_eq!(list(&conn, "local").unwrap().len(), 1);
        // Deleting the local Profile drops its joins.
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM profiles WHERE id = 'local';").unwrap();
        assert!(list(&conn, "local").unwrap().is_empty());
    }
}

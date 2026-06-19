use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AbundioError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_folder: String,
    pub env_json: String,
    pub agent_presets_json: String,
    pub file_tabs_json: String,
    pub base_branch: Option<String>,
    pub last_branch: Option<String>,
    pub position: i32,
    pub profile_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Worktree setup commands run in a newly created worktree's terminal
    /// after an in-app Add worktree. Only meaningful on a main-worktree
    /// Workspace. Empty string = none. See ADR-0017.
    pub worktree_setup_commands: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdate {
    pub name: Option<String>,
    pub root_folder: Option<String>,
    pub env_json: Option<String>,
    pub agent_presets_json: Option<String>,
    pub file_tabs_json: Option<String>,
    pub base_branch: Option<Option<String>>,
    pub last_branch: Option<String>,
    pub worktree_setup_commands: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub layout_json: String,
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabUpdate {
    pub name: Option<String>,
    pub layout_json: Option<String>,
    pub position: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWithTabs {
    #[serde(flatten)]
    pub workspace: Workspace,
    pub tabs: Vec<Tab>,
}

// ── Agent telemetry ──
//
// One AgentTurnRecord per Turn (a single prompt -> turn-finished cycle). See
// docs/plans/agent-turn-telemetry-and-statistics-overlay.md and ADR-0018.
// All measured timestamps are Unix milliseconds; `created_at` is Unix seconds
// (DB default, set on insert). Line counts are `Option` — `None` means
// "unattributed" (e.g. two Turns overlapped in one Workspace).

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub profile_id: String,
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_name: String,
    pub agent_id: String,
    #[serde(default)]
    pub pty_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub working_ms: Option<i64>,
    pub waiting_ms: Option<i64>,
    pub end_reason: Option<String>,
    #[serde(default)]
    pub permission_requests_count: i64,
    #[serde(default)]
    pub error_count: i64,
    pub lines_added: Option<i64>,
    pub lines_deleted: Option<i64>,
    pub files_changed: Option<i64>,
    pub git_added_start: Option<i64>,
    pub git_deleted_start: Option<i64>,
    pub git_added_end: Option<i64>,
    pub git_deleted_end: Option<i64>,
    /// Row provenance (Unix seconds). Set by the DB default on insert; ignored
    /// on the way in (frontend omits it).
    #[serde(default)]
    pub created_at: i64,
}

/// A bucketed aggregate row (one per date bucket, optionally per agent or
/// per workspace). All sums are NULL-safe (overlap Turns with NULL line counts
/// contribute 0 to line totals but still count toward `turn_count`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnBucket {
    pub bucket: String,
    pub agent_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub turn_count: i64,
    /// Turns whose line counts are attributed (non-NULL) — lets the UI show
    /// "N of M Turns measured".
    pub attributed_turn_count: i64,
    pub total_duration_ms: i64,
    pub total_working_ms: i64,
    pub total_waiting_ms: i64,
    pub total_lines_added: i64,
    pub total_lines_deleted: i64,
    pub total_files_changed: i64,
    pub total_permission_requests: i64,
    pub total_errors: i64,
}

/// Overall totals across the whole range (no bucketing).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnTotals {
    pub turn_count: i64,
    pub attributed_turn_count: i64,
    pub session_count: i64,
    pub total_duration_ms: i64,
    pub total_working_ms: i64,
    pub total_waiting_ms: i64,
    pub total_lines_added: i64,
    pub total_lines_deleted: i64,
    pub total_files_changed: i64,
    pub total_permission_requests: i64,
    pub total_errors: i64,
    pub longest_turn_ms: i64,
}

/// Calendar bucket granularity for telemetry rollups.
#[derive(Debug, Clone, Copy)]
pub enum Bucket {
    Day,
    Month,
    Year,
}

impl Bucket {
    pub fn parse(s: &str) -> Result<Bucket, AbundioError> {
        match s {
            "day" => Ok(Bucket::Day),
            "month" => Ok(Bucket::Month),
            "year" => Ok(Bucket::Year),
            other => Err(AbundioError::InvalidOperation(format!(
                "invalid telemetry bucket: {other}"
            ))),
        }
    }

    /// SQLite strftime format. Hardcoded per variant — never user input.
    fn strftime(self) -> &'static str {
        match self {
            Bucket::Day => "%Y-%m-%d",
            Bucket::Month => "%Y-%m",
            Bucket::Year => "%Y",
        }
    }
}

/// Optional secondary grouping dimension for telemetry rollups.
#[derive(Debug, Clone, Copy)]
pub enum GroupBy {
    None,
    Agent,
    Workspace,
}

impl GroupBy {
    pub fn parse(s: &str) -> Result<GroupBy, AbundioError> {
        match s {
            "none" => Ok(GroupBy::None),
            "agent" => Ok(GroupBy::Agent),
            "workspace" => Ok(GroupBy::Workspace),
            other => Err(AbundioError::InvalidOperation(format!(
                "invalid telemetry groupBy: {other}"
            ))),
        }
    }
}

pub struct WorkspaceStore {
    pub conn: Mutex<Connection>,
}

impl WorkspaceStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    // ── Workspace CRUD ──

    pub fn create(
        &self,
        name: &str,
        root_folder: &str,
        profile_id: &str,
    ) -> Result<WorkspaceWithTabs, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let workspace_id = uuid::Uuid::new_v4().to_string();

        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM workspaces WHERE profile_id = ?1",
            [profile_id],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder, position, profile_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![workspace_id, name, root_folder, position, profile_id],
        )?;

        // Create default first tab
        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = uuid::Uuid::new_v4().to_string();
        let layout_json = format!(
            r#"{{"type":"terminal","id":"{}","ptyId":""}}"#,
            pane_id
        );

        conn.execute(
            "INSERT INTO tabs (id, workspace_id, name, layout_json, position) VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![tab_id, workspace_id, "Terminal 1", layout_json],
        )?;

        let workspace = Self::get_workspace_with_conn(&conn, &workspace_id)?;
        let tabs = Self::list_tabs_with_conn(&conn, &workspace_id)?;
        Ok(WorkspaceWithTabs { workspace, tabs })
    }

    pub fn list(&self, profile_id: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.root_folder, s.env_json, s.agent_presets_json, s.file_tabs_json, s.base_branch, s.last_branch, s.position, s.profile_id, s.created_at, s.updated_at, s.worktree_setup_commands,
                    t.id, t.workspace_id, t.name, t.layout_json, t.position, t.created_at, t.updated_at
             FROM workspaces s
             LEFT JOIN tabs t ON t.workspace_id = s.id
             WHERE s.profile_id = ?1
             ORDER BY s.position ASC, t.position ASC",
        )?;

        let mut result: Vec<WorkspaceWithTabs> = Vec::new();
        let mut last_workspace_id: Option<String> = None;

        let mut rows = stmt.query([profile_id])?;
        while let Some(row) = rows.next()? {
            let workspace_id: String = row.get(0)?;

            // Start a new workspace group if the workspace ID changed
            if last_workspace_id.as_ref() != Some(&workspace_id) {
                result.push(WorkspaceWithTabs {
                    workspace: Workspace {
                        id: workspace_id.clone(),
                        name: row.get(1)?,
                        root_folder: row.get(2)?,
                        env_json: row.get(3)?,
                        agent_presets_json: row.get(4)?,
                        file_tabs_json: row.get(5)?,
                        base_branch: row.get(6)?,
                        last_branch: row.get(7)?,
                        position: row.get(8)?,
                        profile_id: row.get(9)?,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        worktree_setup_commands: row.get(12)?,
                    },
                    tabs: Vec::new(),
                });
                last_workspace_id = Some(workspace_id);
            }

            // Append tab if present (LEFT JOIN may produce NULL tab columns)
            let tab_id: Option<String> = row.get(13)?;
            if let Some(tid) = tab_id {
                if let Some(entry) = result.last_mut() {
                    entry.tabs.push(Tab {
                        id: tid,
                        workspace_id: row.get(14)?,
                        name: row.get(15)?,
                        layout_json: row.get(16)?,
                        position: row.get(17)?,
                        created_at: row.get(18)?,
                        updated_at: row.get(19)?,
                    });
                }
            }
        }

        Ok(result)
    }

    pub fn update(&self, id: &str, updates: WorkspaceUpdate) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();

        let mut sets = vec!["updated_at = unixepoch()".to_string()];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(ref name) = updates.name {
            sets.push(format!("name = ?{}", params.len() + 1));
            params.push(Box::new(name.clone()));
        }
        if let Some(ref root_folder) = updates.root_folder {
            sets.push(format!("root_folder = ?{}", params.len() + 1));
            params.push(Box::new(root_folder.clone()));
        }
        if let Some(ref env_json) = updates.env_json {
            sets.push(format!("env_json = ?{}", params.len() + 1));
            params.push(Box::new(env_json.clone()));
        }
        if let Some(ref agent_presets_json) = updates.agent_presets_json {
            sets.push(format!("agent_presets_json = ?{}", params.len() + 1));
            params.push(Box::new(agent_presets_json.clone()));
        }
        if let Some(ref file_tabs_json) = updates.file_tabs_json {
            sets.push(format!("file_tabs_json = ?{}", params.len() + 1));
            params.push(Box::new(file_tabs_json.clone()));
        }
        if let Some(ref base_branch) = updates.base_branch {
            sets.push(format!("base_branch = ?{}", params.len() + 1));
            params.push(Box::new(base_branch.clone()));
        }
        if let Some(ref last_branch) = updates.last_branch {
            sets.push(format!("last_branch = ?{}", params.len() + 1));
            params.push(Box::new(last_branch.clone()));
        }
        if let Some(ref cmds) = updates.worktree_setup_commands {
            sets.push(format!("worktree_setup_commands = ?{}", params.len() + 1));
            params.push(Box::new(cmds.clone()));
        }

        let idx = params.len() + 1;
        params.push(Box::new(id.to_string()));

        let sql = format!("UPDATE workspaces SET {} WHERE id = ?{}", sets.join(", "), idx);

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())?;

        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Tab CRUD ──

    pub fn create_tab(&self, workspace_id: &str, name: &str) -> Result<Tab, AbundioError> {
        let conn = self.conn.lock().unwrap();

        // Get next position
        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tabs WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;

        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = uuid::Uuid::new_v4().to_string();
        let layout_json = format!(
            r#"{{"type":"terminal","id":"{}","ptyId":""}}"#,
            pane_id
        );

        conn.execute(
            "INSERT INTO tabs (id, workspace_id, name, layout_json, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![tab_id, workspace_id, name, layout_json, position],
        )?;

        Self::get_tab_with_conn(&conn, &tab_id)
    }

    pub fn list_tabs(&self, workspace_id: &str) -> Result<Vec<Tab>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Self::list_tabs_with_conn(&conn, workspace_id)
    }

    pub fn update_tab(&self, id: &str, updates: TabUpdate) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();

        let mut sets = vec!["updated_at = unixepoch()".to_string()];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(ref name) = updates.name {
            sets.push(format!("name = ?{}", params.len() + 1));
            params.push(Box::new(name.clone()));
        }
        if let Some(ref layout_json) = updates.layout_json {
            sets.push(format!("layout_json = ?{}", params.len() + 1));
            params.push(Box::new(layout_json.clone()));
        }
        if let Some(ref position) = updates.position {
            sets.push(format!("position = ?{}", params.len() + 1));
            params.push(Box::new(*position));
        }

        let idx = params.len() + 1;
        params.push(Box::new(id.to_string()));

        let sql = format!("UPDATE tabs SET {} WHERE id = ?{}", sets.join(", "), idx);

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())?;

        Ok(())
    }

    pub fn delete_tab(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tabs WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Notes ──
    //
    // Each workspace has at most one Note — a rich-text scratchpad stored as
    // opaque TipTap JSON. The store never parses `content`; it's a plain string
    // round-tripped to the frontend editor. A missing row means "no note yet",
    // surfaced as an empty string.

    pub fn get_note(&self, workspace_id: &str) -> Result<String, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT content FROM notes WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(String::new()),
            other => Err(AbundioError::Db(other)),
        })
    }

    pub fn set_note(&self, workspace_id: &str, content: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notes (workspace_id, content, updated_at)
             VALUES (?1, ?2, unixepoch())
             ON CONFLICT(workspace_id) DO UPDATE SET content = ?2, updated_at = unixepoch()",
            rusqlite::params![workspace_id, content],
        )?;
        Ok(())
    }

    pub fn reorder_workspaces(&self, ids: &[String]) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE workspaces SET position = ?1 WHERE id = ?2",
                rusqlite::params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Agent telemetry ──

    /// Persists a Turn (insert, or replace by id — finalize is idempotent).
    /// `created_at` is omitted so the DB default (Unix seconds) fires.
    pub fn record_agent_turn(&self, t: &AgentTurnRecord) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO agent_turn
               (id, session_id, profile_id, workspace_id, workspace_path, workspace_name,
                agent_id, pty_id, started_at, ended_at, duration_ms, working_ms, waiting_ms,
                end_reason, permission_requests_count, error_count,
                lines_added, lines_deleted, files_changed,
                git_added_start, git_deleted_start, git_added_end, git_deleted_end)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            rusqlite::params![
                t.id,
                t.session_id,
                t.profile_id,
                t.workspace_id,
                t.workspace_path,
                t.workspace_name,
                t.agent_id,
                t.pty_id,
                t.started_at,
                t.ended_at,
                t.duration_ms,
                t.working_ms,
                t.waiting_ms,
                t.end_reason,
                t.permission_requests_count,
                t.error_count,
                t.lines_added,
                t.lines_deleted,
                t.files_changed,
                t.git_added_start,
                t.git_deleted_start,
                t.git_added_end,
                t.git_deleted_end,
            ],
        )?;
        Ok(())
    }

    /// Bucketed rollups for the Statistics overlay, scoped to one Profile and a
    /// `[from_ms, to_ms)` window. Open Turns (`ended_at IS NULL`) are excluded.
    /// The `strftime` format and the optional grouping column come from the
    /// `Bucket`/`GroupBy` enums (hardcoded), not from user strings — `profile_id`
    /// and the bounds are bound parameters.
    pub fn agent_turn_buckets(
        &self,
        profile_id: &str,
        from_ms: i64,
        to_ms: i64,
        bucket: Bucket,
        group_by: GroupBy,
    ) -> Result<Vec<AgentTurnBucket>, AbundioError> {
        let fmt = bucket.strftime();
        let (dim_select, dim_group) = match group_by {
            GroupBy::None => ("NULL AS agent_id, NULL AS workspace_id, NULL AS workspace_name", ""),
            GroupBy::Agent => (
                "agent_id, NULL AS workspace_id, NULL AS workspace_name",
                ", agent_id",
            ),
            GroupBy::Workspace => (
                "NULL AS agent_id, workspace_id, MAX(workspace_name) AS workspace_name",
                ", workspace_id",
            ),
        };
        let sql = format!(
            "SELECT strftime('{fmt}', started_at/1000, 'unixepoch', 'localtime') AS bucket,
                    {dim_select},
                    COUNT(*) AS turn_count,
                    COALESCE(SUM(CASE WHEN lines_added IS NOT NULL THEN 1 ELSE 0 END), 0) AS attributed_turn_count,
                    COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
                    COALESCE(SUM(working_ms), 0) AS total_working_ms,
                    COALESCE(SUM(waiting_ms), 0) AS total_waiting_ms,
                    COALESCE(SUM(lines_added), 0) AS total_lines_added,
                    COALESCE(SUM(lines_deleted), 0) AS total_lines_deleted,
                    COALESCE(SUM(files_changed), 0) AS total_files_changed,
                    COALESCE(SUM(permission_requests_count), 0) AS total_permission_requests,
                    COALESCE(SUM(error_count), 0) AS total_errors
             FROM agent_turn
             WHERE profile_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND ended_at IS NOT NULL
             GROUP BY bucket{dim_group}
             ORDER BY bucket ASC"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params![profile_id, from_ms, to_ms], |row| {
                Ok(AgentTurnBucket {
                    bucket: row.get(0)?,
                    agent_id: row.get(1)?,
                    workspace_id: row.get(2)?,
                    workspace_name: row.get(3)?,
                    turn_count: row.get(4)?,
                    attributed_turn_count: row.get(5)?,
                    total_duration_ms: row.get(6)?,
                    total_working_ms: row.get(7)?,
                    total_waiting_ms: row.get(8)?,
                    total_lines_added: row.get(9)?,
                    total_lines_deleted: row.get(10)?,
                    total_files_changed: row.get(11)?,
                    total_permission_requests: row.get(12)?,
                    total_errors: row.get(13)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Overall totals over the whole `[from_ms, to_ms)` window for one Profile.
    pub fn agent_turn_totals(
        &self,
        profile_id: &str,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<AgentTurnTotals, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let totals = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN lines_added IS NOT NULL THEN 1 ELSE 0 END), 0),
                    COUNT(DISTINCT session_id),
                    COALESCE(SUM(duration_ms), 0), COALESCE(SUM(working_ms), 0), COALESCE(SUM(waiting_ms), 0),
                    COALESCE(SUM(lines_added), 0), COALESCE(SUM(lines_deleted), 0), COALESCE(SUM(files_changed), 0),
                    COALESCE(SUM(permission_requests_count), 0),
                    COALESCE(SUM(error_count), 0), COALESCE(MAX(duration_ms), 0)
             FROM agent_turn
             WHERE profile_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND ended_at IS NOT NULL",
            rusqlite::params![profile_id, from_ms, to_ms],
            |row| {
                Ok(AgentTurnTotals {
                    turn_count: row.get(0)?,
                    attributed_turn_count: row.get(1)?,
                    session_count: row.get(2)?,
                    total_duration_ms: row.get(3)?,
                    total_working_ms: row.get(4)?,
                    total_waiting_ms: row.get(5)?,
                    total_lines_added: row.get(6)?,
                    total_lines_deleted: row.get(7)?,
                    total_files_changed: row.get(8)?,
                    total_permission_requests: row.get(9)?,
                    total_errors: row.get(10)?,
                    longest_turn_ms: row.get(11)?,
                })
            },
        )?;
        Ok(totals)
    }

    /// Raw Turn rows for a Profile in a window (drill-down table), newest first.
    pub fn list_agent_turns(
        &self,
        profile_id: &str,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Vec<AgentTurnRecord>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, profile_id, workspace_id, workspace_path, workspace_name,
                    agent_id, pty_id, started_at, ended_at, duration_ms, working_ms, waiting_ms,
                    end_reason, permission_requests_count, error_count,
                    lines_added, lines_deleted, files_changed,
                    git_added_start, git_deleted_start, git_added_end, git_deleted_end, created_at
             FROM agent_turn
             WHERE profile_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND ended_at IS NOT NULL
             ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![profile_id, from_ms, to_ms], Self::row_to_agent_turn)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Closes any Turns left open by a crash / hard quit so aggregation
    /// (which filters `ended_at IS NOT NULL`) stays clean. We have no reliable
    /// last-activity timestamp for a crashed Turn, so it's closed at its start
    /// (near-zero duration) rather than left open forever. Idempotent.
    pub fn recover_orphan_turns(&self) -> Result<u32, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE agent_turn
             SET ended_at = started_at,
                 duration_ms = 0,
                 working_ms = COALESCE(working_ms, 0),
                 waiting_ms = COALESCE(waiting_ms, 0),
                 end_reason = 'orphan_recovered'
             WHERE ended_at IS NULL",
            [],
        )?;
        Ok(affected as u32)
    }

    fn row_to_agent_turn(row: &rusqlite::Row) -> rusqlite::Result<AgentTurnRecord> {
        Ok(AgentTurnRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            profile_id: row.get(2)?,
            workspace_id: row.get(3)?,
            workspace_path: row.get(4)?,
            workspace_name: row.get(5)?,
            agent_id: row.get(6)?,
            pty_id: row.get(7)?,
            started_at: row.get(8)?,
            ended_at: row.get(9)?,
            duration_ms: row.get(10)?,
            working_ms: row.get(11)?,
            waiting_ms: row.get(12)?,
            end_reason: row.get(13)?,
            permission_requests_count: row.get(14)?,
            error_count: row.get(15)?,
            lines_added: row.get(16)?,
            lines_deleted: row.get(17)?,
            files_changed: row.get(18)?,
            git_added_start: row.get(19)?,
            git_deleted_start: row.get(20)?,
            git_added_end: row.get(21)?,
            git_deleted_end: row.get(22)?,
            created_at: row.get(23)?,
        })
    }

    // ── Internal helpers ──

    fn get_workspace_with_conn(conn: &Connection, id: &str) -> Result<Workspace, AbundioError> {
        conn.query_row(
            "SELECT id, name, root_folder, env_json, agent_presets_json, file_tabs_json, base_branch, last_branch, position, profile_id, created_at, updated_at, worktree_setup_commands
             FROM workspaces WHERE id = ?1",
            [id],
            |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    env_json: row.get(3)?,
                    agent_presets_json: row.get(4)?,
                    file_tabs_json: row.get(5)?,
                    base_branch: row.get(6)?,
                    last_branch: row.get(7)?,
                    position: row.get(8)?,
                    profile_id: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    worktree_setup_commands: row.get(12)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AbundioError::NotFound(format!("Workspace not found: {}", id))
            }
            other => AbundioError::Db(other),
        })
    }

    fn list_tabs_with_conn(conn: &Connection, workspace_id: &str) -> Result<Vec<Tab>, AbundioError> {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, layout_json, position, created_at, updated_at
             FROM tabs WHERE workspace_id = ?1 ORDER BY position ASC",
        )?;

        let tabs = stmt
            .query_map([workspace_id], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    layout_json: row.get(3)?,
                    position: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(tabs)
    }

    fn get_tab_with_conn(conn: &Connection, id: &str) -> Result<Tab, AbundioError> {
        conn.query_row(
            "SELECT id, workspace_id, name, layout_json, position, created_at, updated_at
             FROM tabs WHERE id = ?1",
            [id],
            |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    layout_json: row.get(3)?,
                    position: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AbundioError::NotFound(format!("Tab not found: {}", id))
            }
            other => AbundioError::Db(other),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> WorkspaceStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        WorkspaceStore::new(conn)
    }

    const DEFAULT_PID: &str = "00000000-0000-0000-0000-000000000001";

    #[test]
    fn create_workspace_returns_workspace_with_tab() {
        let store = test_store();
        let result = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        assert_eq!(result.workspace.name, "Test");
        assert_eq!(result.workspace.root_folder, "/tmp");
        assert_eq!(result.workspace.profile_id, DEFAULT_PID);
        assert_eq!(result.tabs.len(), 1);
        assert_eq!(result.tabs[0].name, "Terminal 1");
    }

    #[test]
    fn list_workspaces_returns_created() {
        let store = test_store();
        store.create("A", "/a", DEFAULT_PID).unwrap();
        store.create("B", "/b", DEFAULT_PID).unwrap();
        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].workspace.name, "A");
        assert_eq!(workspaces[1].workspace.name, "B");
    }

    #[test]
    fn list_filters_by_profile() {
        let store = test_store();
        // Create another profile by inserting directly
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO profiles (id, name, position) VALUES ('p2', 'Other', 1)",
                [],
            )
            .unwrap();
        store.create("Default-A", "/a", DEFAULT_PID).unwrap();
        store.create("Other-A", "/a", "p2").unwrap();
        store.create("Other-B", "/b", "p2").unwrap();
        let default_list = store.list(DEFAULT_PID).unwrap();
        let other_list = store.list("p2").unwrap();
        assert_eq!(default_list.len(), 1);
        assert_eq!(other_list.len(), 2);
        assert_eq!(default_list[0].workspace.name, "Default-A");
    }

    #[test]
    fn list_workspaces_ordered_by_position() {
        let store = test_store();
        store.create("First", "/a", DEFAULT_PID).unwrap();
        store.create("Second", "/b", DEFAULT_PID).unwrap();
        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces[0].workspace.position, 0);
        assert_eq!(workspaces[1].workspace.position, 1);
    }

    #[test]
    fn update_workspace_name() {
        let store = test_store();
        let created = store.create("Old", "/tmp", DEFAULT_PID).unwrap();
        store
            .update(
                &created.workspace.id,
                WorkspaceUpdate {
                    name: Some("New".to_string()),
                    root_folder: None,
                    env_json: None,
                    agent_presets_json: None,
                    file_tabs_json: None,
                    base_branch: None,
                    last_branch: None,
                    worktree_setup_commands: None,
                },
            )
            .unwrap();
        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces[0].workspace.name, "New");
    }

    #[test]
    fn delete_workspace() {
        let store = test_store();
        let created = store.create("ToDelete", "/tmp", DEFAULT_PID).unwrap();
        store.delete(&created.workspace.id).unwrap();
        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces.len(), 0);
    }

    #[test]
    fn delete_workspace_cascades_to_tabs() {
        let store = test_store();
        let created = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let workspace_id = created.workspace.id.clone();
        store.create_tab(&workspace_id, "Tab 2").unwrap();
        store.delete(&workspace_id).unwrap();
        // Tabs should also be deleted via CASCADE
        let tabs = store.list_tabs(&workspace_id).unwrap();
        assert_eq!(tabs.len(), 0);
    }

    #[test]
    fn create_tab() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let tab = store.create_tab(&workspace.workspace.id, "Tab 2").unwrap();
        assert_eq!(tab.name, "Tab 2");
        assert_eq!(tab.position, 1);
    }

    #[test]
    fn list_tabs_ordered() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        store.create_tab(&workspace.workspace.id, "Tab 2").unwrap();
        store.create_tab(&workspace.workspace.id, "Tab 3").unwrap();
        let tabs = store.list_tabs(&workspace.workspace.id).unwrap();
        assert_eq!(tabs.len(), 3); // 1 default + 2 created
        assert_eq!(tabs[0].name, "Terminal 1");
        assert_eq!(tabs[1].name, "Tab 2");
        assert_eq!(tabs[2].name, "Tab 3");
    }

    #[test]
    fn update_tab_name() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let tab_id = workspace.tabs[0].id.clone();
        store
            .update_tab(
                &tab_id,
                TabUpdate {
                    name: Some("Renamed".to_string()),
                    layout_json: None,
                    position: None,
                },
            )
            .unwrap();
        let tabs = store.list_tabs(&workspace.workspace.id).unwrap();
        assert_eq!(tabs[0].name, "Renamed");
    }

    #[test]
    fn update_tab_layout() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let tab_id = workspace.tabs[0].id.clone();
        let new_layout = r#"{"type":"terminal","id":"new","ptyId":""}"#;
        store
            .update_tab(
                &tab_id,
                TabUpdate {
                    name: None,
                    layout_json: Some(new_layout.to_string()),
                    position: None,
                },
            )
            .unwrap();
        let tabs = store.list_tabs(&workspace.workspace.id).unwrap();
        assert_eq!(tabs[0].layout_json, new_layout);
    }

    #[test]
    fn delete_tab() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let tab_id = workspace.tabs[0].id.clone();
        store.delete_tab(&tab_id).unwrap();
        let tabs = store.list_tabs(&workspace.workspace.id).unwrap();
        assert_eq!(tabs.len(), 0);
    }

    #[test]
    fn reorder_workspaces() {
        let store = test_store();
        let s1 = store.create("A", "/a", DEFAULT_PID).unwrap();
        let s2 = store.create("B", "/b", DEFAULT_PID).unwrap();
        let s3 = store.create("C", "/c", DEFAULT_PID).unwrap();

        store
            .reorder_workspaces(&[
                s3.workspace.id.clone(),
                s1.workspace.id.clone(),
                s2.workspace.id.clone(),
            ])
            .unwrap();

        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces[0].workspace.name, "C");
        assert_eq!(workspaces[1].workspace.name, "A");
        assert_eq!(workspaces[2].workspace.name, "B");
    }

    #[test]
    fn get_note_returns_empty_when_absent() {
        let store = test_store();
        let ws = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        assert_eq!(store.get_note(&ws.workspace.id).unwrap(), "");
    }

    #[test]
    fn set_then_get_note_round_trips() {
        let store = test_store();
        let ws = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let json = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
        store.set_note(&ws.workspace.id, json).unwrap();
        assert_eq!(store.get_note(&ws.workspace.id).unwrap(), json);
    }

    #[test]
    fn set_note_upserts_without_duplicates() {
        let store = test_store();
        let ws = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        store.set_note(&ws.workspace.id, "first").unwrap();
        store.set_note(&ws.workspace.id, "second").unwrap();
        assert_eq!(store.get_note(&ws.workspace.id).unwrap(), "second");
        let count: i32 = store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE workspace_id = ?1",
                [&ws.workspace.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn delete_workspace_cascades_to_note() {
        let store = test_store();
        let ws = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        store.set_note(&ws.workspace.id, "keep notes").unwrap();
        store.delete(&ws.workspace.id).unwrap();
        let count: i32 = store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE workspace_id = ?1",
                [&ws.workspace.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    // ── Agent telemetry ──

    /// Builds a finalized Turn. `day_ms` is the start time in Unix ms; helpers
    /// below pass specific local-day timestamps to lock bucketing.
    fn turn(id: &str, profile_id: &str, agent: &str, start_ms: i64, dur_ms: i64) -> AgentTurnRecord {
        AgentTurnRecord {
            id: id.into(),
            session_id: Some(format!("sess-{id}")),
            profile_id: profile_id.into(),
            workspace_id: Some("w1".into()),
            workspace_path: "/tmp/w1".into(),
            workspace_name: "W1".into(),
            agent_id: agent.into(),
            pty_id: "pty1".into(),
            started_at: start_ms,
            ended_at: Some(start_ms + dur_ms),
            duration_ms: Some(dur_ms),
            working_ms: Some(dur_ms),
            waiting_ms: Some(0),
            end_reason: Some("stop".into()),
            permission_requests_count: 1,
            error_count: 0,
            lines_added: Some(10),
            lines_deleted: Some(2),
            files_changed: Some(1),
            git_added_start: Some(0),
            git_deleted_start: Some(0),
            git_added_end: Some(10),
            git_deleted_end: Some(2),
            created_at: 0,
        }
    }

    // 2026-03-10 12:00 and 2026-04-10 12:00 UTC — far from any midnight so the
    // local-day bucket is unambiguous regardless of the test machine's tz.
    const MAR_10_MS: i64 = 1_741_608_000_000;
    const APR_10_MS: i64 = 1_744_286_400_000;

    #[test]
    fn record_agent_turn_inserts_and_replace_is_idempotent() {
        let store = test_store();
        let mut t = turn("t1", DEFAULT_PID, "claude", MAR_10_MS, 5000);
        store.record_agent_turn(&t).unwrap();
        // Re-finalize same id (e.g. quit flush racing): replaces, no dup.
        t.duration_ms = Some(6000);
        store.record_agent_turn(&t).unwrap();
        let count: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_turn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let dur: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT duration_ms FROM agent_turn WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dur, 6000);
    }

    #[test]
    fn record_agent_turn_with_unknown_workspace_id_succeeds() {
        // workspace_id is NOT a FK — a Turn can reference a deleted workspace.
        let store = test_store();
        let mut t = turn("t1", DEFAULT_PID, "claude", MAR_10_MS, 1000);
        t.workspace_id = Some("does-not-exist".into());
        store.record_agent_turn(&t).unwrap();
    }

    #[test]
    fn deleting_workspace_keeps_its_turns() {
        // #4 split lifetime: Workspace delete must NOT remove historical Turns.
        let store = test_store();
        let ws = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        let mut t = turn("t1", DEFAULT_PID, "claude", MAR_10_MS, 1000);
        t.workspace_id = Some(ws.workspace.id.clone());
        store.record_agent_turn(&t).unwrap();
        store.delete(&ws.workspace.id).unwrap();
        let count: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_turn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "Turn must survive its Workspace deletion");
    }

    #[test]
    fn deleting_profile_cascades_to_turns() {
        // #4 split lifetime: Profile delete DOES remove its Turns (FK cascade).
        let store = test_store();
        store
            .conn
            .lock()
            .unwrap()
            .execute("INSERT INTO profiles (id, name, position) VALUES ('p2','Other',1)", [])
            .unwrap();
        store
            .record_agent_turn(&turn("t1", "p2", "claude", MAR_10_MS, 1000))
            .unwrap();
        // Delete profile p2 directly (cascade fires because foreign_keys=ON).
        store
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM profiles WHERE id='p2'", [])
            .unwrap();
        let count: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM agent_turn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "Turns must cascade-delete with their Profile");
    }

    #[test]
    fn buckets_group_by_day_and_filter_by_profile() {
        let store = test_store();
        store
            .conn
            .lock()
            .unwrap()
            .execute("INSERT INTO profiles (id, name, position) VALUES ('p2','Other',1)", [])
            .unwrap();
        store.record_agent_turn(&turn("a", DEFAULT_PID, "claude", MAR_10_MS, 1000)).unwrap();
        store.record_agent_turn(&turn("b", DEFAULT_PID, "claude", MAR_10_MS + 3_600_000, 2000)).unwrap();
        store.record_agent_turn(&turn("c", DEFAULT_PID, "gemini", APR_10_MS, 4000)).unwrap();
        // A different profile's Turn must not leak into DEFAULT_PID's buckets.
        store.record_agent_turn(&turn("x", "p2", "claude", MAR_10_MS, 9999)).unwrap();

        let buckets = store
            .agent_turn_buckets(DEFAULT_PID, 0, i64::MAX, Bucket::Day, GroupBy::None)
            .unwrap();
        assert_eq!(buckets.len(), 2, "two distinct local days");
        // March bucket: two turns, durations 1000+2000.
        let mar = &buckets[0];
        assert_eq!(mar.turn_count, 2);
        assert_eq!(mar.total_duration_ms, 3000);
        assert_eq!(mar.total_lines_added, 20);
    }

    #[test]
    fn buckets_group_by_agent_and_month() {
        let store = test_store();
        store.record_agent_turn(&turn("a", DEFAULT_PID, "claude", MAR_10_MS, 1000)).unwrap();
        store.record_agent_turn(&turn("b", DEFAULT_PID, "gemini", MAR_10_MS, 2000)).unwrap();
        let buckets = store
            .agent_turn_buckets(DEFAULT_PID, 0, i64::MAX, Bucket::Month, GroupBy::Agent)
            .unwrap();
        assert_eq!(buckets.len(), 2, "one row per agent in the month");
        assert!(buckets.iter().all(|b| b.bucket.len() == 7)); // YYYY-MM
        assert!(buckets.iter().any(|b| b.agent_id.as_deref() == Some("claude")));
        assert!(buckets.iter().any(|b| b.agent_id.as_deref() == Some("gemini")));
    }

    #[test]
    fn buckets_exclude_open_turns_and_null_lines() {
        let store = test_store();
        // Finalized, attributed.
        store.record_agent_turn(&turn("a", DEFAULT_PID, "claude", MAR_10_MS, 1000)).unwrap();
        // Finalized but unattributed (overlap null-out): lines NULL.
        let mut nulled = turn("b", DEFAULT_PID, "claude", MAR_10_MS + 1000, 1000);
        nulled.lines_added = None;
        nulled.lines_deleted = None;
        nulled.files_changed = None;
        store.record_agent_turn(&nulled).unwrap();
        // Open turn — must be excluded.
        let mut open = turn("c", DEFAULT_PID, "claude", MAR_10_MS + 2000, 0);
        open.ended_at = None;
        open.duration_ms = None;
        store.record_agent_turn(&open).unwrap();

        let buckets = store
            .agent_turn_buckets(DEFAULT_PID, 0, i64::MAX, Bucket::Day, GroupBy::None)
            .unwrap();
        assert_eq!(buckets.len(), 1);
        let b = &buckets[0];
        assert_eq!(b.turn_count, 2, "two finalized turns; open one excluded");
        assert_eq!(b.attributed_turn_count, 1, "only one turn has line counts");
        assert_eq!(b.total_lines_added, 10, "NULL lines contribute 0");
    }

    #[test]
    fn totals_match() {
        let store = test_store();
        store.record_agent_turn(&turn("a", DEFAULT_PID, "claude", MAR_10_MS, 1000)).unwrap();
        store.record_agent_turn(&turn("b", DEFAULT_PID, "gemini", APR_10_MS, 5000)).unwrap();
        let totals = store.agent_turn_totals(DEFAULT_PID, 0, i64::MAX).unwrap();
        assert_eq!(totals.turn_count, 2);
        assert_eq!(totals.session_count, 2);
        assert_eq!(totals.total_duration_ms, 6000);
        assert_eq!(totals.longest_turn_ms, 5000);
        assert_eq!(totals.total_lines_added, 20);
    }

    #[test]
    fn recover_orphan_turns_closes_open_rows_idempotently() {
        let store = test_store();
        let mut open = turn("a", DEFAULT_PID, "claude", MAR_10_MS, 0);
        open.ended_at = None;
        open.duration_ms = None;
        open.working_ms = None;
        store.record_agent_turn(&open).unwrap();

        let recovered = store.recover_orphan_turns().unwrap();
        assert_eq!(recovered, 1);
        let (ended, reason): (Option<i64>, Option<String>) = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT ended_at, end_reason FROM agent_turn WHERE id='a'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(ended, Some(MAR_10_MS));
        assert_eq!(reason.as_deref(), Some("orphan_recovered"));

        // Second call is a no-op.
        assert_eq!(store.recover_orphan_turns().unwrap(), 0);
    }

    #[test]
    fn list_agent_turns_returns_rows_newest_first() {
        let store = test_store();
        store.record_agent_turn(&turn("old", DEFAULT_PID, "claude", MAR_10_MS, 1000)).unwrap();
        store.record_agent_turn(&turn("new", DEFAULT_PID, "claude", APR_10_MS, 1000)).unwrap();
        let rows = store.list_agent_turns(DEFAULT_PID, 0, i64::MAX).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "new");
        assert_eq!(rows[1].id, "old");
        assert!(rows[0].created_at > 0, "created_at populated by DB default");
    }
}

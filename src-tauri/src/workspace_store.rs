use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AbundioError;

/// The name of a new Workspace's first Tab. Same literal as `FIRST_TAB_NAME`
/// in `src/lib/tabName.ts`; change both together.
const FIRST_TAB_NAME: &str = "Tab 1";

/// Name of every Orchestrator workspace and of its first Tab.
pub const ORCHESTRATOR_NAME: &str = "Orchestrator";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_folder: String,
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
    /// `"work"` for an ordinary Workspace, `"orchestrator"` for a Profile's
    /// Orchestrator workspace (ADR-0057).
    pub kind: String,
}

/// One **Orchestrator tab** holding a file (ADR-0058). `path` is absolute
/// for `file`, Workspace-relative for `diff` and `commit`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorTab {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub path: String,
    pub commit_oid: Option<String>,
    pub preview: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOrchestratorTab {
    pub workspace_id: String,
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub commit_oid: Option<String>,
    #[serde(default)]
    pub preview: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdate {
    pub name: Option<String>,
    pub root_folder: Option<String>,
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

#[derive(Debug, Default, Deserialize)]
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

/// A Profile's **Workspace restore** list (ADR-0052), as `restore_set`
/// returns it: only Workspaces whose folder still exists, in sidebar order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSet {
    pub opened: Vec<String>,
    pub active: Option<String>,
}

/// The ids whose folder does not exist, from `WorkspaceStore::folder_rows`.
/// Touches the disk, so call it off the async runtime (`spawn_blocking`).
pub fn missing_ids(rows: Vec<(String, String)>, folder_exists: impl Fn(&str) -> bool) -> Vec<String> {
    rows.into_iter()
        .filter(|(_, folder)| !folder_exists(folder))
        .map(|(id, _)| id)
        .collect()
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
            rusqlite::params![tab_id, workspace_id, FIRST_TAB_NAME, layout_json],
        )?;

        let workspace = Self::get_workspace_with_conn(&conn, &workspace_id)?;
        let tabs = Self::list_tabs_with_conn(&conn, &workspace_id)?;
        Ok(WorkspaceWithTabs { workspace, tabs })
    }

    pub fn list(&self, profile_id: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.root_folder, s.agent_presets_json, s.file_tabs_json, s.base_branch, s.last_branch, s.position, s.profile_id, s.created_at, s.updated_at, s.worktree_setup_commands, s.kind,
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
                        agent_presets_json: row.get(3)?,
                        file_tabs_json: row.get(4)?,
                        base_branch: row.get(5)?,
                        last_branch: row.get(6)?,
                        position: row.get(7)?,
                        profile_id: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        worktree_setup_commands: row.get(11)?,
                        kind: row.get(12)?,
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

    /// The Workspace's folder, or `None` if it no longer exists.
    pub fn root_folder_of(&self, workspace_id: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT root_folder FROM workspaces WHERE id = ?1", [workspace_id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// The Workspace's kind (`"work"` / `"orchestrator"`), or `None` if it no
    /// longer exists.
    pub fn kind_of(&self, workspace_id: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT kind FROM workspaces WHERE id = ?1", [workspace_id], |r| r.get(0))
            .optional()?)
    }

    /// `list` without the Orchestrator workspace: what Agent control means
    /// by "the Profile's Workspaces" (ADR-0057).
    pub fn list_work(&self, profile_id: &str) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let mut all = self.list(profile_id)?;
        all.retain(|w| w.workspace.kind != "orchestrator");
        Ok(all)
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

    // ── Orchestrator workspace (ADR-0057) ──

    /// The Profile's Orchestrator workspace, created on first call with
    /// `folder` as its folder. Idempotent: later calls return the same row,
    /// and repoint it at `folder` if the app data folder moved.
    pub fn ensure_orchestrator(
        &self,
        profile_id: &str,
        folder: &str,
    ) -> Result<WorkspaceWithTabs, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM workspaces WHERE profile_id = ?1 AND kind = 'orchestrator'",
                [profile_id],
                |row| row.get(0),
            )
            .optional()?;
        let workspace_id = match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE workspaces SET root_folder = ?2 WHERE id = ?1 AND root_folder <> ?2",
                    rusqlite::params![id, folder],
                )?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                // Position -1: never in the Workspace list, so it must not
                // take a slot there either.
                conn.execute(
                    "INSERT INTO workspaces (id, name, root_folder, position, profile_id, kind) VALUES (?1, ?2, ?3, -1, ?4, 'orchestrator')",
                    rusqlite::params![id, ORCHESTRATOR_NAME, folder, profile_id],
                )?;
                let tab_id = uuid::Uuid::new_v4().to_string();
                let pane_id = uuid::Uuid::new_v4().to_string();
                let layout_json = format!(r#"{{"type":"terminal","id":"{}","ptyId":""}}"#, pane_id);
                conn.execute(
                    "INSERT INTO tabs (id, workspace_id, name, layout_json, position) VALUES (?1, ?2, ?3, ?4, 0)",
                    rusqlite::params![tab_id, id, ORCHESTRATOR_NAME, layout_json],
                )?;
                id
            }
        };
        let workspace = Self::get_workspace_with_conn(&conn, &workspace_id)?;
        let tabs = Self::list_tabs_with_conn(&conn, &workspace_id)?;
        Ok(WorkspaceWithTabs { workspace, tabs })
    }

    // ── Orchestrator tabs (ADR-0058) ──

    /// The Profile's Orchestrator file tabs, in order, and the selected one.
    pub fn orchestrator_tabs(
        &self,
        profile_id: &str,
    ) -> Result<(Vec<OrchestratorTab>, Option<String>), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, kind, path, commit_oid, preview FROM orchestrator_tabs
             WHERE profile_id = ?1 ORDER BY position ASC, created_at ASC",
        )?;
        let tabs = stmt
            .query_map([profile_id], |r| {
                Ok(OrchestratorTab {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    kind: r.get(2)?,
                    path: r.get(3)?,
                    commit_oid: r.get(4)?,
                    preview: r.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let selected: Option<Option<String>> = conn
            .query_row(
                "SELECT orchestrator_selected_tab FROM profiles WHERE id = ?1",
                [profile_id],
                |r| r.get(0),
            )
            .optional()?;
        let selected = selected.flatten().filter(|id| tabs.iter().any(|t| &t.id == id));
        Ok((tabs, selected))
    }

    /// Adds a file tab, or returns the one already open for the same file,
    /// kind and commit in that Workspace. Refuses a Workspace of another
    /// Profile.
    pub fn add_orchestrator_tab(
        &self,
        profile_id: &str,
        tab: NewOrchestratorTab,
    ) -> Result<OrchestratorTab, AbundioError> {
        if !matches!(tab.kind.as_str(), "file" | "diff" | "commit") {
            return Err(AbundioError::InvalidOperation(format!("Not a tab kind: {}", tab.kind)));
        }
        let conn = self.conn.lock().unwrap();
        let owner: Option<String> = conn
            .query_row("SELECT profile_id FROM workspaces WHERE id = ?1", [&tab.workspace_id], |r| r.get(0))
            .optional()?;
        if owner.as_deref() != Some(profile_id) {
            return Err(AbundioError::NotFound(format!("Workspace not found: {}", tab.workspace_id)));
        }
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT id, preview FROM orchestrator_tabs WHERE profile_id = ?1 AND workspace_id = ?2
                   AND kind = ?3 AND path = ?4 AND COALESCE(commit_oid, '') = COALESCE(?5, '')",
                rusqlite::params![profile_id, tab.workspace_id, tab.kind, tab.path, tab.commit_oid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, preview)) = existing {
            return Ok(OrchestratorTab {
                id,
                workspace_id: tab.workspace_id,
                kind: tab.kind,
                path: tab.path,
                commit_oid: tab.commit_oid,
                preview: preview != 0,
            });
        }
        let id = uuid::Uuid::new_v4().to_string();
        let position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM orchestrator_tabs WHERE profile_id = ?1",
            [profile_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO orchestrator_tabs (id, profile_id, workspace_id, position, kind, path, commit_oid, preview)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                profile_id,
                tab.workspace_id,
                position,
                tab.kind,
                tab.path,
                tab.commit_oid,
                tab.preview as i64
            ],
        )?;
        Ok(OrchestratorTab {
            id,
            workspace_id: tab.workspace_id,
            kind: tab.kind,
            path: tab.path,
            commit_oid: tab.commit_oid,
            preview: tab.preview,
        })
    }

    pub fn remove_orchestrator_tab(&self, profile_id: &str, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM orchestrator_tabs WHERE profile_id = ?1 AND id = ?2",
            rusqlite::params![profile_id, id],
        )?;
        Ok(())
    }

    /// Remembers which Orchestrator tab is selected; `None` is the graph.
    pub fn set_orchestrator_selected_tab(
        &self,
        profile_id: &str,
        id: Option<&str>,
    ) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE profiles SET orchestrator_selected_tab = ?2 WHERE id = ?1",
            rusqlite::params![profile_id, id],
        )?;
        Ok(())
    }

    /// The Agent id the user picked for this Profile's Orchestrator, if any.
    pub fn orchestrator_agent(&self, profile_id: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let agent: Option<Option<String>> = conn
            .query_row(
                "SELECT orchestrator_agent_id FROM profiles WHERE id = ?1",
                [profile_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(agent.flatten())
    }

    pub fn set_orchestrator_agent(
        &self,
        profile_id: &str,
        agent_id: Option<&str>,
    ) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE profiles SET orchestrator_agent_id = ?2 WHERE id = ?1",
            rusqlite::params![profile_id, agent_id],
        )?;
        if n == 0 {
            return Err(AbundioError::NotFound(format!("Profile not found: {}", profile_id)));
        }
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

    // ── Missing folder (ADR-0053) ──

    /// A Workspace's folder, or `None` for an unknown id.
    pub fn root_folder(&self, workspace_id: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT root_folder FROM workspaces WHERE id = ?1",
                [workspace_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// `(id, root_folder)` for each of the Profile's Workspaces, in sidebar
    /// order. Reads the database only; the caller checks the disk, with the
    /// lock released, so a hung network mount cannot stall other store calls.
    pub fn folder_rows(&self, profile_id: &str) -> Result<Vec<(String, String)>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, root_folder FROM workspaces WHERE profile_id = ?1 ORDER BY position ASC",
        )?;
        let mapped = stmt.query_map([profile_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(mapped.collect::<Result<_, _>>()?)
    }

    // ── Workspace restore (ADR-0052) ──

    /// Puts a Workspace on (or takes it off) its Profile's restore list.
    pub fn set_restore_opened(&self, workspace_id: &str, opened: bool) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            // The Orchestrator workspace is opened by its view, never by
            // Workspace restore (ADR-0057).
            "UPDATE workspaces SET restore_opened = ?1 WHERE id = ?2 AND kind = 'work'",
            rusqlite::params![opened as i32, workspace_id],
        )?;
        Ok(())
    }

    /// Remembers which Workspace was Active in a Profile. Ignored unless the
    /// Workspace belongs to that Profile.
    pub fn set_restore_active(&self, profile_id: &str, workspace_id: Option<&str>) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        match workspace_id {
            Some(wid) => conn.execute(
                "UPDATE profiles SET restore_active_workspace_id = ?2
                 WHERE id = ?1
                   AND EXISTS (SELECT 1 FROM workspaces WHERE id = ?2 AND profile_id = ?1)",
                rusqlite::params![profile_id, wid],
            )?,
            None => conn.execute(
                "UPDATE profiles SET restore_active_workspace_id = NULL WHERE id = ?1",
                [profile_id],
            )?,
        };
        Ok(())
    }

    /// The Profile's restore list. A Workspace whose folder is not a
    /// directory right now is left out of this restore but **stays on the
    /// list**: an external drive, network share or encrypted volume may simply
    /// not be mounted yet, and it comes back once the folder does. Only the
    /// user closing a Workspace takes it off. A remembered Active id that is
    /// not in the returned list is cleared.
    pub fn restore_set(&self, profile_id: &str) -> Result<RestoreSet, AbundioError> {
        self.restore_set_with(profile_id, |p| std::path::Path::new(p).is_dir())
    }

    fn restore_set_with(
        &self,
        profile_id: &str,
        folder_exists: impl Fn(&str) -> bool,
    ) -> Result<RestoreSet, AbundioError> {
        let rows: Vec<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, root_folder FROM workspaces
                 WHERE profile_id = ?1 AND restore_opened = 1
                 ORDER BY position ASC",
            )?;
            let mapped = stmt.query_map([profile_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            mapped.collect::<Result<_, _>>()?
        };
        // Checked with the lock released: on a hung network mount `stat` can
        // block for seconds, and every other WorkspaceStore IPC would wait.
        let opened: Vec<String> = rows
            .into_iter()
            .filter(|(_, folder)| folder_exists(folder))
            .map(|(id, _)| id)
            .collect();
        let conn = self.conn.lock().unwrap();
        let saved: Option<String> = conn
            .query_row(
                "SELECT restore_active_workspace_id FROM profiles WHERE id = ?1",
                [profile_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let active = match saved {
            Some(id) if opened.contains(&id) => Some(id),
            Some(_) => {
                conn.execute(
                    "UPDATE profiles SET restore_active_workspace_id = NULL WHERE id = ?1",
                    [profile_id],
                )?;
                None
            }
            None => None,
        };
        Ok(RestoreSet { opened, active })
    }

    // ── Pane numbers (Agent control, ADR-0054) ──

    /// The **Pane number** of each pane, in the order given, claiming new
    /// numbers for panes that have none yet. New numbers follow the order of
    /// `pane_ids`, so a caller passing panes in tree order numbers an existing
    /// layout in tree order. One transaction: two callers never get the same
    /// number, and a number is never reused, because the counter only grows.
    pub fn pane_numbers(
        &self,
        workspace_id: &str,
        pane_ids: &[String],
    ) -> Result<Vec<(String, u32)>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut next: u32 = tx
            .query_row(
                "SELECT next_pane_number FROM workspaces WHERE id = ?1",
                [workspace_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AbundioError::NotFound(format!("Workspace not found: {workspace_id}")))?;
        let first = next;
        let mut out = Vec::with_capacity(pane_ids.len());
        for pane_id in pane_ids {
            let existing: Option<u32> = tx
                .query_row(
                    "SELECT number FROM pane_numbers WHERE workspace_id = ?1 AND pane_id = ?2",
                    rusqlite::params![workspace_id, pane_id],
                    |r| r.get(0),
                )
                .optional()?;
            let number = match existing {
                Some(n) => n,
                None => {
                    tx.execute(
                        "INSERT INTO pane_numbers (workspace_id, pane_id, number) VALUES (?1, ?2, ?3)",
                        rusqlite::params![workspace_id, pane_id, next],
                    )?;
                    next += 1;
                    next - 1
                }
            };
            out.push((pane_id.clone(), number));
        }
        // A read-only call (every pane already numbered) writes nothing.
        if next != first {
            tx.execute(
                "UPDATE workspaces SET next_pane_number = ?1 WHERE id = ?2",
                rusqlite::params![next, workspace_id],
            )?;
            tx.commit()?;
        }
        Ok(out)
    }

    /// The raw connection, for other modules' tests to set up rows this
    /// store has no method for (another Profile, say).
    #[cfg(test)]
    pub fn conn_for_tests(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    /// The Profile a Workspace belongs to.
    pub fn profile_of(&self, workspace_id: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT profile_id FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(AbundioError::Db(other)),
        })
    }

    /// Every **Agent handle** in a Profile's layouts, as `(workspace_id,
    /// workspace name, pane_id, handle)`. Read from the database, which every
    /// Window writes its layouts to, so it covers the Profile's other Windows
    /// too (ADR-0055).
    pub fn profile_handles(
        &self,
        profile_id: &str,
    ) -> Result<Vec<(String, String, String, String)>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT w.id, w.name, t.layout_json FROM workspaces w
             JOIN tabs t ON t.workspace_id = w.id
             WHERE w.profile_id = ?1",
        )?;
        let rows = stmt
            .query_map([profile_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        for (ws_id, ws_name, layout) in rows {
            let Ok(tree) = serde_json::from_str::<serde_json::Value>(&layout) else {
                continue;
            };
            let mut stack = vec![&tree];
            while let Some(node) = stack.pop() {
                match node.get("type").and_then(|t| t.as_str()) {
                    Some("terminal") => {
                        if let (Some(id), Some(h)) = (
                            node.get("id").and_then(|v| v.as_str()),
                            node.get("agentHandle").and_then(|v| v.as_str()),
                        ) {
                            out.push((ws_id.clone(), ws_name.clone(), id.to_string(), h.to_string()));
                        }
                    }
                    Some("split") => {
                        for side in ["first", "second"] {
                            if let Some(child) = node.get(side) {
                                stack.push(child);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(out)
    }

    /// The pane that holds a **Pane number** in a Workspace, if any. A number
    /// whose pane has closed still answers with that pane's id; the caller
    /// checks the pane is still in a layout.
    pub fn pane_for_number(&self, workspace_id: &str, number: u32) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT pane_id FROM pane_numbers WHERE workspace_id = ?1 AND number = ?2",
                rusqlite::params![workspace_id, number],
                |r| r.get(0),
            )
            .optional()?)
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
            "SELECT id, name, root_folder, agent_presets_json, file_tabs_json, base_branch, last_branch, position, profile_id, created_at, updated_at, worktree_setup_commands, kind
             FROM workspaces WHERE id = ?1",
            [id],
            |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    agent_presets_json: row.get(3)?,
                    file_tabs_json: row.get(4)?,
                    base_branch: row.get(5)?,
                    last_branch: row.get(6)?,
                    position: row.get(7)?,
                    profile_id: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    worktree_setup_commands: row.get(11)?,
                    kind: row.get(12)?,
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

    // ── App-global settings (the `settings` key-value table) ──
    //
    // Scalars that belong to the whole app rather than to a Workspace, a Tab or
    // a Profile. The table has existed since 001_init.sql; `last_seen_version`
    // (the What's new card's gate — see ADR-0036) is its first key. It lives
    // here, and not in the frontend's `localStorage`-backed settings store,
    // because localStorage is per-webview on macOS: every Window would keep its
    // own copy and each would show its own card.

    /// Reads an app-global setting. `None` when the key was never written —
    /// callers must treat "absent" and "empty" as different (a fresh install has
    /// no `last_seen_version`, which is not the same as having seen "").
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(AbundioError::Db)
    }

    /// Writes an app-global setting, replacing any existing value.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    // ── Agent seeding (ADR-0037) ──

    /// Whether this install still owes a seeding — a database an earlier
    /// launch created but never seeded from, because the `$PATH` scan came back
    /// empty or the user quit inside the five seconds `shell_path()` can take.
    pub fn agent_seeding_is_pending(&self) -> Result<bool, AbundioError> {
        Ok(self.get_setting(AGENT_SEEDING_PENDING_KEY)?.is_some())
    }

    /// Records that this install was created by this launch and has not seeded
    /// yet, so later launches can tell it apart from a database that predates
    /// the feature entirely. Without it, "the file exists" is true on every
    /// launch after the first and a failed first scan would have its claim
    /// spent unseeded the very next time the app starts. Idempotent.
    pub fn mark_agent_seeding_pending(&self) -> Result<(), AbundioError> {
        self.set_setting(AGENT_SEEDING_PENDING_KEY, "1")
    }

    /// Spends the one-time claim. Called on the upgrade path at startup, and
    /// again by the frontend once a seed has actually been applied.
    ///
    /// An existing install keeps the toggles it has: switching an Agent off
    /// also removes its hooks, so seeding a configured app would move switches
    /// the user is relying on. Idempotent, and clears the pending marker since
    /// nothing is owed any more.
    pub fn mark_agent_seeding_done(&self) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '1')
             ON CONFLICT(key) DO NOTHING",
            [AGENT_SEEDING_KEY],
        )?;
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            [AGENT_SEEDING_PENDING_KEY],
        )?;
        Ok(())
    }

    /// Whether the one-time claim has already been spent.
    pub fn agent_seeding_is_done(&self) -> Result<bool, AbundioError> {
        Ok(self.get_setting(AGENT_SEEDING_KEY)?.is_some())
    }
}

/// What startup should record about **Agent seeding**, given the three facts it
/// can observe. Pure, because this is the part of the mechanism where a wrong
/// answer is silent: it doesn't fail, it just leaves a user with nine toggles
/// they never set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedingStartupAction {
    /// This launch created the database. Note that a seed is owed, so a later
    /// launch can still tell this apart from an upgrade.
    MarkPending,
    /// The database predates **Agent seeding** entirely — the upgrade path.
    /// Spend the claim without seeding.
    MarkDone,
    /// Either seeding already happened, or an earlier launch created this
    /// install and still owes a seed. Leave the claim alone so it can retry.
    Nothing,
}

/// Decide what startup should record. See [`SeedingStartupAction`].
///
/// The ordering matters: `pending` is only meaningful while `seeded` is false,
/// and "the file already existed" means *upgrade* only when no earlier launch
/// claimed it as a new install.
pub fn seeding_startup_action(
    db_was_absent: bool,
    seeded: bool,
    pending: bool,
) -> SeedingStartupAction {
    if seeded {
        SeedingStartupAction::Nothing
    } else if db_was_absent {
        SeedingStartupAction::MarkPending
    } else if pending {
        SeedingStartupAction::Nothing
    } else {
        SeedingStartupAction::MarkDone
    }
}

/// App-global `settings` key recording that **Agent seeding** has had its one
/// chance — whether it was used (a new install) or spent unseeded (an upgrade).
pub const AGENT_SEEDING_KEY: &str = "agents_seeded";

/// App-global `settings` key marking an install this app created but has not
/// seeded yet. Its absence on a database that already existed is what
/// identifies the upgrade path.
pub const AGENT_SEEDING_PENDING_KEY: &str = "agents_seeding_pending";

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

    // ── Pane numbers (ADR-0054) ──

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_orchestrator_is_left_out_of_list_work_and_workspace_restore() {
        let store = test_store();
        let work = store.create("w", "/w", DEFAULT_PID).unwrap().workspace.id;
        let orch = store.ensure_orchestrator(DEFAULT_PID, "/o").unwrap().workspace.id;
        let ids: Vec<String> = store.list_work(DEFAULT_PID).unwrap().into_iter().map(|w| w.workspace.id).collect();
        assert_eq!(ids, vec![work.clone()]);
        assert_eq!(store.list(DEFAULT_PID).unwrap().len(), 2);
        store.set_restore_opened(&orch, true).unwrap();
        store.set_restore_opened(&work, true).unwrap();
        let conn = store.conn.lock().unwrap();
        let flagged: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces WHERE restore_opened = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(flagged, 1);
    }

    #[test]
    fn pane_numbers_follow_the_given_order_and_are_stable() {
        let store = test_store();
        let ws = store.create("w", "/w", DEFAULT_PID).unwrap().workspace.id;
        let first = store.pane_numbers(&ws, &ids(&["a", "b", "c"])).unwrap();
        assert_eq!(first, vec![("a".into(), 1), ("b".into(), 2), ("c".into(), 3)]);
        // Asking again, in another order, changes nothing.
        let again = store.pane_numbers(&ws, &ids(&["c", "a"])).unwrap();
        assert_eq!(again, vec![("c".into(), 3), ("a".into(), 1)]);
    }

    #[test]
    fn pane_numbers_are_never_reused_after_a_close() {
        let store = test_store();
        let ws = store.create("w", "/w", DEFAULT_PID).unwrap().workspace.id;
        store.pane_numbers(&ws, &ids(&["a", "b"])).unwrap();
        // "b" closed; the next pane gets 3, not 2.
        let next = store.pane_numbers(&ws, &ids(&["a", "d"])).unwrap();
        assert_eq!(next, vec![("a".into(), 1), ("d".into(), 3)]);
    }

    #[test]
    fn pane_numbers_are_per_workspace() {
        let store = test_store();
        let w1 = store.create("w1", "/w1", DEFAULT_PID).unwrap().workspace.id;
        let w2 = store.create("w2", "/w2", DEFAULT_PID).unwrap().workspace.id;
        store.pane_numbers(&w1, &ids(&["a", "b"])).unwrap();
        let other = store.pane_numbers(&w2, &ids(&["x"])).unwrap();
        assert_eq!(other, vec![("x".into(), 1)]);
        assert_eq!(store.pane_for_number(&w1, 2).unwrap().as_deref(), Some("b"));
        assert_eq!(store.pane_for_number(&w2, 2).unwrap(), None);
    }

    #[test]
    fn pane_numbers_survive_a_reopen_of_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let open = || {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
            crate::migrations::run_migrations(&conn).unwrap();
            WorkspaceStore::new(conn)
        };
        let ws = {
            let store = open();
            let ws = store.create("w", "/w", DEFAULT_PID).unwrap().workspace.id;
            store.pane_numbers(&ws, &ids(&["a", "b"])).unwrap();
            ws
        };
        let store = open();
        let after = store.pane_numbers(&ws, &ids(&["b", "new"])).unwrap();
        assert_eq!(after, vec![("b".into(), 2), ("new".into(), 3)]);
    }

    #[test]
    fn pane_numbers_go_with_their_workspace() {
        let store = test_store();
        let ws = store.create("w", "/w", DEFAULT_PID).unwrap().workspace.id;
        store.pane_numbers(&ws, &ids(&["a"])).unwrap();
        store.delete(&ws).unwrap();
        assert!(store.pane_numbers(&ws, &ids(&["a"])).is_err());
        let conn = store.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM pane_numbers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    // ── Missing folder (ADR-0053) ──

    #[test]
    fn missing_folders_lists_only_this_profiles_missing_ones() {
        let store = test_store();
        add_profile(&store, "p2");
        let here = store.create("h", "/here", DEFAULT_PID).unwrap().workspace.id;
        let gone = store.create("g", "/gone", DEFAULT_PID).unwrap().workspace.id;
        store.create("o", "/gone-too", "p2").unwrap();
        let rows = store.folder_rows(DEFAULT_PID).unwrap();
        let missing = missing_ids(rows, |p| p == "/here");
        assert_eq!(missing, vec![gone]);
        assert_eq!(store.root_folder(&here).unwrap().as_deref(), Some("/here"));
        assert_eq!(store.root_folder("nope").unwrap(), None);
    }

    // ── Workspace restore (ADR-0052) ──

    fn add_profile(store: &WorkspaceStore, id: &str) {
        store
            .conn
            .lock()
            .unwrap()
            .execute("INSERT INTO profiles (id, name) VALUES (?1, ?1)", [id])
            .unwrap();
    }

    #[test]
    fn restore_set_round_trips_in_sidebar_order() {
        let store = test_store();
        let a = store.create("a", "/a", DEFAULT_PID).unwrap().workspace.id;
        let b = store.create("b", "/b", DEFAULT_PID).unwrap().workspace.id;
        let c = store.create("c", "/c", DEFAULT_PID).unwrap().workspace.id;
        store.set_restore_opened(&c, true).unwrap();
        store.set_restore_opened(&a, true).unwrap();
        store.set_restore_active(DEFAULT_PID, Some(&c)).unwrap();
        let set = store.restore_set_with(DEFAULT_PID, |_| true).unwrap();
        assert_eq!(set.opened, vec![a.clone(), c.clone()]);
        assert_eq!(set.active, Some(c.clone()));
        store.set_restore_opened(&a, false).unwrap();
        let set = store.restore_set_with(DEFAULT_PID, |_| true).unwrap();
        assert_eq!(set.opened, vec![c]);
        let _ = b;
    }

    #[test]
    fn restore_set_skips_missing_folders_until_they_come_back() {
        let store = test_store();
        let a = store.create("a", "/a", DEFAULT_PID).unwrap().workspace.id;
        let gone = store.create("g", "/gone", DEFAULT_PID).unwrap().workspace.id;
        store.set_restore_opened(&a, true).unwrap();
        store.set_restore_opened(&gone, true).unwrap();
        store.set_restore_active(DEFAULT_PID, Some(&gone)).unwrap();
        let set = store.restore_set_with(DEFAULT_PID, |p| p != "/gone").unwrap();
        assert_eq!(set.opened, vec![a.clone()]);
        assert_eq!(set.active, None);
        // Still on the list: the folder coming back (a drive mounted late)
        // brings the Workspace back too.
        let set = store.restore_set_with(DEFAULT_PID, |_| true).unwrap();
        assert_eq!(set.opened, vec![a, gone]);
    }

    /// A hung network mount must not stall every other store call
    /// (review of #253): the folder check runs with the lock released.
    #[test]
    fn restore_set_checks_folders_without_holding_the_lock() {
        let store = test_store();
        let a = store.create("a", "/a", DEFAULT_PID).unwrap().workspace.id;
        store.set_restore_opened(&a, true).unwrap();
        let set = store
            .restore_set_with(DEFAULT_PID, |_| store.conn.try_lock().is_ok())
            .unwrap();
        assert_eq!(set.opened, vec![a]);
    }

    #[test]
    fn restore_set_is_scoped_to_its_profile() {
        let store = test_store();
        add_profile(&store, "p2");
        let mine = store.create("m", "/m", DEFAULT_PID).unwrap().workspace.id;
        let theirs = store.create("t", "/t", "p2").unwrap().workspace.id;
        store.set_restore_opened(&mine, true).unwrap();
        store.set_restore_opened(&theirs, true).unwrap();
        // Another Profile's Workspace cannot become this Profile's Active.
        store.set_restore_active(DEFAULT_PID, Some(&theirs)).unwrap();
        let set = store.restore_set_with(DEFAULT_PID, |_| true).unwrap();
        assert_eq!(set.opened, vec![mine]);
        assert_eq!(set.active, None);
        assert_eq!(store.restore_set_with("p2", |_| true).unwrap().opened, vec![theirs]);
    }

    #[test]
    fn deleting_the_active_workspace_clears_it_on_read() {
        let store = test_store();
        let a = store.create("a", "/a", DEFAULT_PID).unwrap().workspace.id;
        let b = store.create("b", "/b", DEFAULT_PID).unwrap().workspace.id;
        store.set_restore_opened(&a, true).unwrap();
        store.set_restore_opened(&b, true).unwrap();
        store.set_restore_active(DEFAULT_PID, Some(&b)).unwrap();
        store.delete(&b).unwrap();
        let set = store.restore_set_with(DEFAULT_PID, |_| true).unwrap();
        assert_eq!(set, RestoreSet { opened: vec![a], active: None });
        let saved: Option<String> = store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT restore_active_workspace_id FROM profiles WHERE id = ?1",
                [DEFAULT_PID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, None);
    }

    // ── App-global settings ──

    /// A never-written key reads as `None`, not as an empty string — the What's
    /// new card depends on telling a fresh install (no `last_seen_version`)
    /// apart from a version that was genuinely seen. See ADR-0036.
    #[test]
    fn missing_setting_reads_as_none() {
        let store = test_store();
        assert_eq!(store.get_setting("last_seen_version").unwrap(), None);
    }

    #[test]
    fn setting_round_trips() {
        let store = test_store();
        store.set_setting("last_seen_version", "0.4.0").unwrap();
        assert_eq!(
            store.get_setting("last_seen_version").unwrap(),
            Some("0.4.0".to_string())
        );
    }

    /// Writing the same key again replaces rather than failing on the primary
    /// key — every What's new dismissal writes this key.
    #[test]
    fn setting_write_is_idempotent_and_overwrites() {
        let store = test_store();
        store.set_setting("last_seen_version", "0.4.0").unwrap();
        store.set_setting("last_seen_version", "0.5.0").unwrap();
        assert_eq!(
            store.get_setting("last_seen_version").unwrap(),
            Some("0.5.0".to_string())
        );
    }

    #[test]
    fn settings_keys_are_independent() {
        let store = test_store();
        store.set_setting("a", "1").unwrap();
        store.set_setting("b", "2").unwrap();
        assert_eq!(store.get_setting("a").unwrap(), Some("1".to_string()));
        assert_eq!(store.get_setting("b").unwrap(), Some("2".to_string()));
    }

    // ── Agent seeding (ADR-0037) ──

    /// The truth table startup depends on. A wrong answer here is silent — it
    /// doesn't fail, it leaves a user with nine toggles they never set.
    #[test]
    fn startup_marks_a_brand_new_install_as_pending() {
        assert_eq!(
            seeding_startup_action(true, false, false),
            SeedingStartupAction::MarkPending
        );
    }

    /// The bug this table exists to prevent: on launch 2 of a new install whose
    /// first scan found nothing, the database file exists — but the pending
    /// marker says an earlier launch created it and still owes a seed, so the
    /// claim must survive for this launch to retry.
    #[test]
    fn startup_leaves_an_unseeded_new_install_alone() {
        assert_eq!(
            seeding_startup_action(false, false, true),
            SeedingStartupAction::Nothing
        );
    }

    /// A database that already existed and was never marked pending predates
    /// the feature — spend the claim without seeding, so an upgrade keeps the
    /// toggles (and the hooks) the user has.
    #[test]
    fn startup_spends_the_claim_on_an_upgrade() {
        assert_eq!(
            seeding_startup_action(false, false, false),
            SeedingStartupAction::MarkDone
        );
    }

    /// Once seeded, nothing startup observes can change the answer.
    #[test]
    fn startup_does_nothing_once_seeding_is_done() {
        for db_was_absent in [true, false] {
            for pending in [true, false] {
                assert_eq!(
                    seeding_startup_action(db_was_absent, true, pending),
                    SeedingStartupAction::Nothing,
                    "seeded should win over ({db_was_absent}, {pending})"
                );
            }
        }
    }

    #[test]
    fn seeding_pending_round_trips_and_is_idempotent() {
        let store = test_store();
        assert!(!store.agent_seeding_is_pending().unwrap());
        store.mark_agent_seeding_pending().unwrap();
        store.mark_agent_seeding_pending().unwrap();
        assert!(store.agent_seeding_is_pending().unwrap());
    }

    /// Committing clears the debt as well as spending the claim, so a later
    /// launch reads a plain "done" rather than "done but still owed".
    #[test]
    fn marking_done_spends_the_claim_and_clears_pending() {
        let store = test_store();
        store.mark_agent_seeding_pending().unwrap();
        store.mark_agent_seeding_done().unwrap();

        assert!(store.agent_seeding_is_done().unwrap());
        assert!(!store.agent_seeding_is_pending().unwrap());
    }

    #[test]
    fn marking_done_is_idempotent() {
        let store = test_store();
        store.mark_agent_seeding_done().unwrap();
        store.mark_agent_seeding_done().unwrap();
        assert!(store.agent_seeding_is_done().unwrap());
    }

    /// A fresh install has written neither key — that pair of absences is what
    /// the startup decision reads.
    #[test]
    fn both_seeding_keys_are_absent_on_a_fresh_store() {
        let store = test_store();
        assert_eq!(store.get_setting(AGENT_SEEDING_KEY).unwrap(), None);
        assert_eq!(store.get_setting(AGENT_SEEDING_PENDING_KEY).unwrap(), None);
    }

    #[test]
    fn create_workspace_returns_workspace_with_tab() {
        let store = test_store();
        let result = store.create("Test", "/tmp", DEFAULT_PID).unwrap();
        assert_eq!(result.workspace.name, "Test");
        assert_eq!(result.workspace.root_folder, "/tmp");
        assert_eq!(result.workspace.profile_id, DEFAULT_PID);
        assert_eq!(result.tabs.len(), 1);
        assert_eq!(result.tabs[0].name, FIRST_TAB_NAME);
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
                    agent_presets_json: None,
                    file_tabs_json: None,
                    base_branch: None,
                    last_branch: None,
                    // Also set the LAST column of the workspaces SELECT. Both
                    // `list` and `get_workspace_with_conn` read columns
                    // positionally, so a mis-shifted `row.get(n)` after a column
                    // is added or removed shows up here as a wrong/missing value
                    // rather than silently returning a neighbouring column.
                    worktree_setup_commands: Some("pnpm install".to_string()),
                },
            )
            .unwrap();
        let workspaces = store.list(DEFAULT_PID).unwrap();
        assert_eq!(workspaces[0].workspace.name, "New");
        assert_eq!(workspaces[0].workspace.worktree_setup_commands, "pnpm install");
        assert_eq!(workspaces[0].workspace.profile_id, DEFAULT_PID);
        assert_eq!(workspaces[0].workspace.root_folder, "/tmp");
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
        assert_eq!(tabs[0].name, FIRST_TAB_NAME);
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

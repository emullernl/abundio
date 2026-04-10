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
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
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

    pub fn create(&self, name: &str, root_folder: &str) -> Result<WorkspaceWithTabs, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let workspace_id = uuid::Uuid::new_v4().to_string();

        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM workspaces",
            [],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder, position) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![workspace_id, name, root_folder, position],
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

    pub fn list(&self) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.root_folder, s.env_json, s.agent_presets_json, s.file_tabs_json, s.base_branch, s.position, s.created_at, s.updated_at,
                    t.id, t.workspace_id, t.name, t.layout_json, t.position, t.created_at, t.updated_at
             FROM workspaces s
             LEFT JOIN tabs t ON t.workspace_id = s.id
             ORDER BY s.position ASC, t.position ASC",
        )?;

        let mut result: Vec<WorkspaceWithTabs> = Vec::new();
        let mut last_workspace_id: Option<String> = None;

        let mut rows = stmt.query([])?;
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
                        position: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    },
                    tabs: Vec::new(),
                });
                last_workspace_id = Some(workspace_id);
            }

            // Append tab if present (LEFT JOIN may produce NULL tab columns)
            let tab_id: Option<String> = row.get(10)?;
            if let Some(tid) = tab_id {
                if let Some(entry) = result.last_mut() {
                    entry.tabs.push(Tab {
                        id: tid,
                        workspace_id: row.get(11)?,
                        name: row.get(12)?,
                        layout_json: row.get(13)?,
                        position: row.get(14)?,
                        created_at: row.get(15)?,
                        updated_at: row.get(16)?,
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

    // ── Internal helpers ──

    fn get_workspace_with_conn(conn: &Connection, id: &str) -> Result<Workspace, AbundioError> {
        conn.query_row(
            "SELECT id, name, root_folder, env_json, agent_presets_json, file_tabs_json, base_branch, position, created_at, updated_at
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
                    position: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
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

    #[test]
    fn create_workspace_returns_workspace_with_tab() {
        let store = test_store();
        let result = store.create("Test", "/tmp").unwrap();
        assert_eq!(result.workspace.name, "Test");
        assert_eq!(result.workspace.root_folder, "/tmp");
        assert_eq!(result.tabs.len(), 1);
        assert_eq!(result.tabs[0].name, "Terminal 1");
    }

    #[test]
    fn list_workspaces_returns_created() {
        let store = test_store();
        store.create("A", "/a").unwrap();
        store.create("B", "/b").unwrap();
        let workspaces = store.list().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].workspace.name, "A");
        assert_eq!(workspaces[1].workspace.name, "B");
    }

    #[test]
    fn list_workspaces_ordered_by_position() {
        let store = test_store();
        store.create("First", "/a").unwrap();
        store.create("Second", "/b").unwrap();
        let workspaces = store.list().unwrap();
        assert_eq!(workspaces[0].workspace.position, 0);
        assert_eq!(workspaces[1].workspace.position, 1);
    }

    #[test]
    fn update_workspace_name() {
        let store = test_store();
        let created = store.create("Old", "/tmp").unwrap();
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
                },
            )
            .unwrap();
        let workspaces = store.list().unwrap();
        assert_eq!(workspaces[0].workspace.name, "New");
    }

    #[test]
    fn delete_workspace() {
        let store = test_store();
        let created = store.create("ToDelete", "/tmp").unwrap();
        store.delete(&created.workspace.id).unwrap();
        let workspaces = store.list().unwrap();
        assert_eq!(workspaces.len(), 0);
    }

    #[test]
    fn delete_workspace_cascades_to_tabs() {
        let store = test_store();
        let created = store.create("Test", "/tmp").unwrap();
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
        let workspace = store.create("Test", "/tmp").unwrap();
        let tab = store.create_tab(&workspace.workspace.id, "Tab 2").unwrap();
        assert_eq!(tab.name, "Tab 2");
        assert_eq!(tab.position, 1);
    }

    #[test]
    fn list_tabs_ordered() {
        let store = test_store();
        let workspace = store.create("Test", "/tmp").unwrap();
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
        let workspace = store.create("Test", "/tmp").unwrap();
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
        let workspace = store.create("Test", "/tmp").unwrap();
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
        let workspace = store.create("Test", "/tmp").unwrap();
        let tab_id = workspace.tabs[0].id.clone();
        store.delete_tab(&tab_id).unwrap();
        let tabs = store.list_tabs(&workspace.workspace.id).unwrap();
        assert_eq!(tabs.len(), 0);
    }

    #[test]
    fn reorder_workspaces() {
        let store = test_store();
        let s1 = store.create("A", "/a").unwrap();
        let s2 = store.create("B", "/b").unwrap();
        let s3 = store.create("C", "/c").unwrap();

        store
            .reorder_workspaces(&[
                s3.workspace.id.clone(),
                s1.workspace.id.clone(),
                s2.workspace.id.clone(),
            ])
            .unwrap();

        let workspaces = store.list().unwrap();
        assert_eq!(workspaces[0].workspace.name, "C");
        assert_eq!(workspaces[1].workspace.name, "A");
        assert_eq!(workspaces[2].workspace.name, "B");
    }
}

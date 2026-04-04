use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AbundioError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
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
pub struct SessionUpdate {
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
    pub session_id: String,
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
pub struct SessionWithTabs {
    #[serde(flatten)]
    pub session: Session,
    pub tabs: Vec<Tab>,
}

pub struct SessionStore {
    pub conn: Mutex<Connection>,
}

impl SessionStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    // ── Session CRUD ──

    pub fn create(&self, name: &str, root_folder: &str) -> Result<SessionWithTabs, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();

        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sessions",
            [],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO sessions (id, name, root_folder, position) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, name, root_folder, position],
        )?;

        // Create default first tab
        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = uuid::Uuid::new_v4().to_string();
        let layout_json = format!(
            r#"{{"type":"terminal","id":"{}","ptyId":""}}"#,
            pane_id
        );

        conn.execute(
            "INSERT INTO tabs (id, session_id, name, layout_json, position) VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![tab_id, session_id, "Terminal 1", layout_json],
        )?;

        let session = Self::get_session_with_conn(&conn, &session_id)?;
        let tabs = Self::list_tabs_with_conn(&conn, &session_id)?;
        Ok(SessionWithTabs { session, tabs })
    }

    pub fn list(&self) -> Result<Vec<SessionWithTabs>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.root_folder, s.env_json, s.agent_presets_json, s.file_tabs_json, s.base_branch, s.position, s.created_at, s.updated_at,
                    t.id, t.session_id, t.name, t.layout_json, t.position, t.created_at, t.updated_at
             FROM sessions s
             LEFT JOIN tabs t ON t.session_id = s.id
             ORDER BY s.position ASC, t.position ASC",
        )?;

        let mut result: Vec<SessionWithTabs> = Vec::new();
        let mut last_session_id: Option<String> = None;

        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let session_id: String = row.get(0)?;

            // Start a new session group if the session ID changed
            if last_session_id.as_ref() != Some(&session_id) {
                result.push(SessionWithTabs {
                    session: Session {
                        id: session_id.clone(),
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
                last_session_id = Some(session_id);
            }

            // Append tab if present (LEFT JOIN may produce NULL tab columns)
            let tab_id: Option<String> = row.get(10)?;
            if let Some(tid) = tab_id {
                if let Some(entry) = result.last_mut() {
                    entry.tabs.push(Tab {
                        id: tid,
                        session_id: row.get(11)?,
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

    pub fn update(&self, id: &str, updates: SessionUpdate) -> Result<(), AbundioError> {
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

        let sql = format!("UPDATE sessions SET {} WHERE id = ?{}", sets.join(", "), idx);

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())?;

        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Tab CRUD ──

    pub fn create_tab(&self, session_id: &str, name: &str) -> Result<Tab, AbundioError> {
        let conn = self.conn.lock().unwrap();

        // Get next position
        let position: i32 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tabs WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;

        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = uuid::Uuid::new_v4().to_string();
        let layout_json = format!(
            r#"{{"type":"terminal","id":"{}","ptyId":""}}"#,
            pane_id
        );

        conn.execute(
            "INSERT INTO tabs (id, session_id, name, layout_json, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![tab_id, session_id, name, layout_json, position],
        )?;

        Self::get_tab_with_conn(&conn, &tab_id)
    }

    pub fn list_tabs(&self, session_id: &str) -> Result<Vec<Tab>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Self::list_tabs_with_conn(&conn, session_id)
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

    pub fn reorder_sessions(&self, ids: &[String]) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE sessions SET position = ?1 WHERE id = ?2",
                rusqlite::params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Internal helpers ──

    fn get_session_with_conn(conn: &Connection, id: &str) -> Result<Session, AbundioError> {
        conn.query_row(
            "SELECT id, name, root_folder, env_json, agent_presets_json, file_tabs_json, base_branch, position, created_at, updated_at
             FROM sessions WHERE id = ?1",
            [id],
            |row| {
                Ok(Session {
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
                AbundioError::NotFound(format!("Session not found: {}", id))
            }
            other => AbundioError::Db(other),
        })
    }

    fn list_tabs_with_conn(conn: &Connection, session_id: &str) -> Result<Vec<Tab>, AbundioError> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, name, layout_json, position, created_at, updated_at
             FROM tabs WHERE session_id = ?1 ORDER BY position ASC",
        )?;

        let tabs = stmt
            .query_map([session_id], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
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
            "SELECT id, session_id, name, layout_json, position, created_at, updated_at
             FROM tabs WHERE id = ?1",
            [id],
            |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
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

    fn test_store() -> SessionStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        SessionStore::new(conn)
    }

    #[test]
    fn create_session_returns_session_with_tab() {
        let store = test_store();
        let result = store.create("Test", "/tmp").unwrap();
        assert_eq!(result.session.name, "Test");
        assert_eq!(result.session.root_folder, "/tmp");
        assert_eq!(result.tabs.len(), 1);
        assert_eq!(result.tabs[0].name, "Terminal 1");
    }

    #[test]
    fn list_sessions_returns_created() {
        let store = test_store();
        store.create("A", "/a").unwrap();
        store.create("B", "/b").unwrap();
        let sessions = store.list().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session.name, "A");
        assert_eq!(sessions[1].session.name, "B");
    }

    #[test]
    fn list_sessions_ordered_by_position() {
        let store = test_store();
        store.create("First", "/a").unwrap();
        store.create("Second", "/b").unwrap();
        let sessions = store.list().unwrap();
        assert_eq!(sessions[0].session.position, 0);
        assert_eq!(sessions[1].session.position, 1);
    }

    #[test]
    fn update_session_name() {
        let store = test_store();
        let created = store.create("Old", "/tmp").unwrap();
        store
            .update(
                &created.session.id,
                SessionUpdate {
                    name: Some("New".to_string()),
                    root_folder: None,
                    env_json: None,
                    agent_presets_json: None,
                    file_tabs_json: None,
                    base_branch: None,
                },
            )
            .unwrap();
        let sessions = store.list().unwrap();
        assert_eq!(sessions[0].session.name, "New");
    }

    #[test]
    fn delete_session() {
        let store = test_store();
        let created = store.create("ToDelete", "/tmp").unwrap();
        store.delete(&created.session.id).unwrap();
        let sessions = store.list().unwrap();
        assert_eq!(sessions.len(), 0);
    }

    #[test]
    fn delete_session_cascades_to_tabs() {
        let store = test_store();
        let created = store.create("Test", "/tmp").unwrap();
        let session_id = created.session.id.clone();
        store.create_tab(&session_id, "Tab 2").unwrap();
        store.delete(&session_id).unwrap();
        // Tabs should also be deleted via CASCADE
        let tabs = store.list_tabs(&session_id).unwrap();
        assert_eq!(tabs.len(), 0);
    }

    #[test]
    fn create_tab() {
        let store = test_store();
        let session = store.create("Test", "/tmp").unwrap();
        let tab = store.create_tab(&session.session.id, "Tab 2").unwrap();
        assert_eq!(tab.name, "Tab 2");
        assert_eq!(tab.position, 1);
    }

    #[test]
    fn list_tabs_ordered() {
        let store = test_store();
        let session = store.create("Test", "/tmp").unwrap();
        store.create_tab(&session.session.id, "Tab 2").unwrap();
        store.create_tab(&session.session.id, "Tab 3").unwrap();
        let tabs = store.list_tabs(&session.session.id).unwrap();
        assert_eq!(tabs.len(), 3); // 1 default + 2 created
        assert_eq!(tabs[0].name, "Terminal 1");
        assert_eq!(tabs[1].name, "Tab 2");
        assert_eq!(tabs[2].name, "Tab 3");
    }

    #[test]
    fn update_tab_name() {
        let store = test_store();
        let session = store.create("Test", "/tmp").unwrap();
        let tab_id = session.tabs[0].id.clone();
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
        let tabs = store.list_tabs(&session.session.id).unwrap();
        assert_eq!(tabs[0].name, "Renamed");
    }

    #[test]
    fn update_tab_layout() {
        let store = test_store();
        let session = store.create("Test", "/tmp").unwrap();
        let tab_id = session.tabs[0].id.clone();
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
        let tabs = store.list_tabs(&session.session.id).unwrap();
        assert_eq!(tabs[0].layout_json, new_layout);
    }

    #[test]
    fn delete_tab() {
        let store = test_store();
        let session = store.create("Test", "/tmp").unwrap();
        let tab_id = session.tabs[0].id.clone();
        store.delete_tab(&tab_id).unwrap();
        let tabs = store.list_tabs(&session.session.id).unwrap();
        assert_eq!(tabs.len(), 0);
    }

    #[test]
    fn reorder_sessions() {
        let store = test_store();
        let s1 = store.create("A", "/a").unwrap();
        let s2 = store.create("B", "/b").unwrap();
        let s3 = store.create("C", "/c").unwrap();

        store
            .reorder_sessions(&[
                s3.session.id.clone(),
                s1.session.id.clone(),
                s2.session.id.clone(),
            ])
            .unwrap();

        let sessions = store.list().unwrap();
        assert_eq!(sessions[0].session.name, "C");
        assert_eq!(sessions[1].session.name, "A");
        assert_eq!(sessions[2].session.name, "B");
    }
}

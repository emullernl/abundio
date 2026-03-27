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

        conn.execute(
            "INSERT INTO sessions (id, name, root_folder) VALUES (?1, ?2, ?3)",
            rusqlite::params![session_id, name, root_folder],
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
            "SELECT id, name, root_folder, env_json, agent_presets_json, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    env_json: row.get(3)?,
                    agent_presets_json: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::with_capacity(sessions.len());
        for session in sessions {
            let tabs = Self::list_tabs_with_conn(&conn, &session.id)?;
            result.push(SessionWithTabs { session, tabs });
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

    // ── Internal helpers ──

    fn get_session_with_conn(conn: &Connection, id: &str) -> Result<Session, AbundioError> {
        conn.query_row(
            "SELECT id, name, root_folder, env_json, agent_presets_json, created_at, updated_at
             FROM sessions WHERE id = ?1",
            [id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    env_json: row.get(3)?,
                    agent_presets_json: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
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

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
    pub layout_json: String,
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
    pub layout_json: Option<String>,
    pub env_json: Option<String>,
    pub agent_presets_json: Option<String>,
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

    pub fn create(&self, name: &str, root_folder: &str) -> Result<Session, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO sessions (id, name, root_folder) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, name, root_folder],
        )?;

        self.get_by_id_with_conn(&conn, &id)
    }

    pub fn list(&self) -> Result<Vec<Session>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, root_folder, layout_json, env_json, agent_presets_json, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    layout_json: row.get(3)?,
                    env_json: row.get(4)?,
                    agent_presets_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(sessions)
    }

    pub fn update(&self, id: &str, updates: SessionUpdate) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();

        // Build dynamic UPDATE
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
        if let Some(ref layout_json) = updates.layout_json {
            sets.push(format!("layout_json = ?{}", params.len() + 1));
            params.push(Box::new(layout_json.clone()));
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

    fn get_by_id_with_conn(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Session, AbundioError> {
        conn.query_row(
            "SELECT id, name, root_folder, layout_json, env_json, agent_presets_json, created_at, updated_at
             FROM sessions WHERE id = ?1",
            [id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_folder: row.get(2)?,
                    layout_json: row.get(3)?,
                    env_json: row.get(4)?,
                    agent_presets_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
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
}

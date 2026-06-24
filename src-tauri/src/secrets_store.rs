use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AbundioError;

/// Keychain service name under which every secret value is stored. The
/// account within the service is the secret's id (a UUID), so renaming a
/// secret's env-var name never orphans its keychain entry.
const KEYRING_SERVICE: &str = "abundio";

/// Vault entry as exposed to the frontend — metadata only. The value lives in
/// the OS keychain and is never serialized into this struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Abstraction over the OS secure store. The keyring-backed implementation is
/// used in the app; tests swap in an in-memory backend so the DB/join logic
/// can be verified on headless CI (no secret-service / Keychain available).
pub trait SecretBackend: Send + Sync {
    fn set(&self, id: &str, value: &str) -> Result<(), AbundioError>;
    fn get(&self, id: &str) -> Result<Option<String>, AbundioError>;
    fn delete(&self, id: &str) -> Result<(), AbundioError>;
}

/// Real backend: macOS Keychain / Windows Credential Manager / Linux
/// secret-service via the `keyring` crate.
pub struct KeyringBackend;

impl SecretBackend for KeyringBackend {
    fn set(&self, id: &str, value: &str) -> Result<(), AbundioError> {
        keyring::Entry::new(KEYRING_SERVICE, id)?.set_password(value)?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<String>, AbundioError> {
        match keyring::Entry::new(KEYRING_SERVICE, id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, id: &str) -> Result<(), AbundioError> {
        match keyring::Entry::new(KEYRING_SERVICE, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Manages the secrets vault: metadata + per-workspace assignment in SQLite,
/// values in the OS keychain. Holds its own DB connection (mirrors
/// `ProfileStore`); the keychain backend is stateless.
pub struct SecretsStore {
    pub conn: Mutex<Connection>,
    backend: Box<dyn SecretBackend>,
}

impl SecretsStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            backend: Box::new(KeyringBackend),
        }
    }

    #[cfg(test)]
    pub fn with_backend(conn: Connection, backend: Box<dyn SecretBackend>) -> Self {
        Self {
            conn: Mutex::new(conn),
            backend,
        }
    }

    // ── Vault CRUD ──

    /// Lists all secrets (metadata only) ordered by name. Values are never read.
    pub fn list(&self) -> Result<Vec<SecretMeta>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at
             FROM secrets ORDER BY name COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], Self::map_meta)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Creates a secret: writes metadata, then stores the value in the keychain.
    /// If the keychain write fails the metadata row is rolled back so we never
    /// leave a dangling valueless secret behind.
    pub fn create(
        &self,
        name: &str,
        value: &str,
        description: &str,
    ) -> Result<SecretMeta, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO secrets (id, name, description) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, name, description],
        )?;
        if let Err(e) = self.backend.set(&id, value) {
            conn.execute("DELETE FROM secrets WHERE id = ?1", [&id]).ok();
            return Err(e);
        }
        Self::get_meta(&conn, &id)
    }

    /// Updates a secret. Any of name/description/value may be supplied; absent
    /// fields are left unchanged. A new value overwrites the keychain entry;
    /// renaming does not touch the keychain (the key is the stable id).
    pub fn update(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        value: Option<&str>,
    ) -> Result<SecretMeta, AbundioError> {
        let conn = self.conn.lock().unwrap();

        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM secrets WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AbundioError::NotFound(format!("secret {}", id)));
        }

        let mut sets = vec!["updated_at = unixepoch()".to_string()];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];
        if let Some(name) = name {
            sets.push(format!("name = ?{}", params.len() + 1));
            params.push(Box::new(name.to_string()));
        }
        if let Some(description) = description {
            sets.push(format!("description = ?{}", params.len() + 1));
            params.push(Box::new(description.to_string()));
        }
        let id_idx = params.len() + 1;
        params.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE secrets SET {} WHERE id = ?{}",
            sets.join(", "),
            id_idx
        );
        conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;

        if let Some(value) = value {
            self.backend.set(id, value)?;
        }

        Self::get_meta(&conn, id)
    }

    /// Deletes a secret: removes the keychain value and the metadata row. The
    /// `workspace_secrets` FK cascade clears any assignments.
    pub fn delete(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM secrets WHERE id = ?1", [id])?;
        // Best-effort keychain cleanup; a missing entry is not an error.
        self.backend.delete(id)?;
        Ok(())
    }

    // ── Per-workspace assignment ──

    /// Lists the secrets (metadata) assigned to a workspace.
    pub fn list_for_workspace(&self, workspace_id: &str) -> Result<Vec<SecretMeta>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description, s.created_at, s.updated_at
             FROM secrets s
             JOIN workspace_secrets ws ON ws.secret_id = s.id
             WHERE ws.workspace_id = ?1
             ORDER BY s.name COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([workspace_id], Self::map_meta)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Replaces a workspace's full set of assigned secret ids. The mutex makes
    /// the delete+insert effectively atomic against other writers.
    pub fn set_for_workspace(
        &self,
        workspace_id: &str,
        secret_ids: &[String],
    ) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM workspace_secrets WHERE workspace_id = ?1",
            [workspace_id],
        )?;
        for secret_id in secret_ids {
            conn.execute(
                "INSERT OR IGNORE INTO workspace_secrets (workspace_id, secret_id) VALUES (?1, ?2)",
                rusqlite::params![workspace_id, secret_id],
            )?;
        }
        Ok(())
    }

    /// Resolves the env vars to inject for a workspace's terminals: for each
    /// assigned secret, fetch its value from the keychain. Missing or
    /// unreadable values are skipped with a warning (never the value) so a
    /// flaky/absent keychain can't block a terminal from opening.
    pub fn resolve_env_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<(String, String)>, AbundioError> {
        let metas = self.list_for_workspace(workspace_id)?;
        let mut env = Vec::with_capacity(metas.len());
        for meta in metas {
            match self.backend.get(&meta.id) {
                Ok(Some(value)) => env.push((meta.name, value)),
                Ok(None) => log::warn!(
                    "Secret '{}' ({}) assigned to workspace {} has no keychain value; skipping",
                    meta.name,
                    meta.id,
                    workspace_id
                ),
                Err(e) => log::warn!(
                    "Failed to read secret '{}' ({}) from keychain: {}; skipping",
                    meta.name,
                    meta.id,
                    e
                ),
            }
        }
        Ok(env)
    }

    // ── helpers ──

    fn map_meta(row: &rusqlite::Row) -> Result<SecretMeta, rusqlite::Error> {
        Ok(SecretMeta {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }

    fn get_meta(conn: &Connection, id: &str) -> Result<SecretMeta, AbundioError> {
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at FROM secrets WHERE id = ?1",
            [id],
            Self::map_meta,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AbundioError::NotFound(format!("secret {}", id))
            }
            other => other.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// In-memory stand-in for the OS keychain.
    #[derive(Default)]
    struct MockBackend {
        store: Mutex<HashMap<String, String>>,
    }

    impl SecretBackend for MockBackend {
        fn set(&self, id: &str, value: &str) -> Result<(), AbundioError> {
            self.store
                .lock()
                .unwrap()
                .insert(id.to_string(), value.to_string());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<String>, AbundioError> {
            Ok(self.store.lock().unwrap().get(id).cloned())
        }
        fn delete(&self, id: &str) -> Result<(), AbundioError> {
            self.store.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn test_store() -> SecretsStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        SecretsStore::with_backend(conn, Box::new(MockBackend::default()))
    }

    fn insert_workspace(store: &SecretsStore, id: &str) {
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO workspaces (id, name, root_folder) VALUES (?1, ?2, '/tmp')",
                rusqlite::params![id, id],
            )
            .unwrap();
    }

    #[test]
    fn create_then_list_returns_metadata_only() {
        let store = test_store();
        let meta = store.create("API_KEY", "s3cr3t", "my key").unwrap();
        assert_eq!(meta.name, "API_KEY");
        assert_eq!(meta.description, "my key");

        let all = store.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], meta);
    }

    #[test]
    fn value_is_stored_in_backend_not_returned() {
        let store = test_store();
        let meta = store.create("TOKEN", "abc123", "").unwrap();
        // resolve goes through the backend
        insert_workspace(&store, "w1");
        store.set_for_workspace("w1", &[meta.id.clone()]).unwrap();
        let env = store.resolve_env_for_workspace("w1").unwrap();
        assert_eq!(env, vec![("TOKEN".to_string(), "abc123".to_string())]);
    }

    #[test]
    fn update_changes_metadata_and_value() {
        let store = test_store();
        let meta = store.create("DB", "old", "").unwrap();
        insert_workspace(&store, "w1");
        store.set_for_workspace("w1", &[meta.id.clone()]).unwrap();

        store
            .update(&meta.id, Some("DB_PASS"), Some("prod"), Some("new"))
            .unwrap();

        let listed = store.list().unwrap();
        assert_eq!(listed[0].name, "DB_PASS");
        assert_eq!(listed[0].description, "prod");
        let env = store.resolve_env_for_workspace("w1").unwrap();
        assert_eq!(env, vec![("DB_PASS".to_string(), "new".to_string())]);
    }

    #[test]
    fn update_without_value_keeps_keychain_value() {
        let store = test_store();
        let meta = store.create("K", "keep", "").unwrap();
        insert_workspace(&store, "w1");
        store.set_for_workspace("w1", &[meta.id.clone()]).unwrap();

        store.update(&meta.id, Some("K2"), None, None).unwrap();

        let env = store.resolve_env_for_workspace("w1").unwrap();
        assert_eq!(env, vec![("K2".to_string(), "keep".to_string())]);
    }

    #[test]
    fn update_missing_secret_is_not_found() {
        let store = test_store();
        let err = store.update("nope", Some("x"), None, None).unwrap_err();
        assert!(matches!(err, AbundioError::NotFound(_)));
    }

    #[test]
    fn delete_removes_value_and_assignment() {
        let store = test_store();
        let meta = store.create("X", "v", "").unwrap();
        insert_workspace(&store, "w1");
        store.set_for_workspace("w1", &[meta.id.clone()]).unwrap();

        store.delete(&meta.id).unwrap();

        assert!(store.list().unwrap().is_empty());
        // Cascade cleared the assignment.
        assert!(store.list_for_workspace("w1").unwrap().is_empty());
        assert!(store.resolve_env_for_workspace("w1").unwrap().is_empty());
    }

    #[test]
    fn set_for_workspace_replaces_previous_set() {
        let store = test_store();
        let a = store.create("A", "1", "").unwrap();
        let b = store.create("B", "2", "").unwrap();
        let c = store.create("C", "3", "").unwrap();
        insert_workspace(&store, "w1");

        store
            .set_for_workspace("w1", &[a.id.clone(), b.id.clone()])
            .unwrap();
        assert_eq!(store.list_for_workspace("w1").unwrap().len(), 2);

        // Replace with a different set.
        store.set_for_workspace("w1", &[c.id.clone()]).unwrap();
        let assigned = store.list_for_workspace("w1").unwrap();
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].name, "C");
    }

    #[test]
    fn deleting_workspace_cascades_assignment() {
        let store = test_store();
        let a = store.create("A", "1", "").unwrap();
        insert_workspace(&store, "w1");
        store.set_for_workspace("w1", &[a.id.clone()]).unwrap();

        store
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM workspaces WHERE id = 'w1'", [])
            .unwrap();

        // The secret itself survives; only the assignment is gone.
        assert_eq!(store.list().unwrap().len(), 1);
        assert!(store.list_for_workspace("w1").unwrap().is_empty());
    }

    #[test]
    fn resolve_skips_secret_missing_from_keychain() {
        let store = test_store();
        let a = store.create("A", "1", "").unwrap();
        let b = store.create("B", "2", "").unwrap();
        insert_workspace(&store, "w1");
        store
            .set_for_workspace("w1", &[a.id.clone(), b.id.clone()])
            .unwrap();

        // Simulate a keychain entry that vanished out from under us.
        store.backend.delete(&a.id).unwrap();

        let env = store.resolve_env_for_workspace("w1").unwrap();
        assert_eq!(env, vec![("B".to_string(), "2".to_string())]);
    }

    #[test]
    fn resolve_empty_for_unassigned_workspace() {
        let store = test_store();
        store.create("A", "1", "").unwrap();
        insert_workspace(&store, "w1");
        assert!(store.resolve_env_for_workspace("w1").unwrap().is_empty());
    }
}

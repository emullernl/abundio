use rusqlite::Connection;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_init", include_str!("../migrations/001_init.sql")),
    ("002_add_tabs", include_str!("../migrations/002_add_tabs.sql")),
    (
        "003_add_session_position",
        include_str!("../migrations/003_add_session_position.sql"),
    ),
    (
        "004_add_file_tabs",
        include_str!("../migrations/004_add_file_tabs.sql"),
    ),
    (
        "005_add_base_branch",
        include_str!("../migrations/005_add_base_branch.sql"),
    ),
    (
        "006_rename_sessions_to_workspaces",
        include_str!("../migrations/006_rename_sessions_to_workspaces.sql"),
    ),
    (
        "007_add_last_branch",
        include_str!("../migrations/007_add_last_branch.sql"),
    ),
    (
        "008_add_profiles",
        include_str!("../migrations/008_add_profiles.sql"),
    ),
    (
        "009_recover_lost_tabs",
        include_str!("../migrations/009_recover_lost_tabs.sql"),
    ),
    ("010_add_notes", include_str!("../migrations/010_add_notes.sql")),
    (
        "011_add_worktree_setup_commands",
        include_str!("../migrations/011_add_worktree_setup_commands.sql"),
    ),
    (
        "012_add_agent_turns",
        include_str!("../migrations/012_add_agent_turns.sql"),
    ),
    (
        "013_add_workspace_env_vars",
        include_str!("../migrations/013_add_workspace_env_vars.sql"),
    ),
];

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )",
    )?;

    for (name, sql) in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;

        if !already_applied {
            apply_one(conn, name, sql)?;
            log::info!("Applied migration: {}", name);
        }
    }

    Ok(())
}

/// Applies a single migration atomically: the migration SQL and the
/// bookkeeping `_migrations` row commit together, or both roll back.
///
/// **PRAGMA foreign_keys handling.** SQLite documents that `PRAGMA
/// foreign_keys` is a no-op inside an open transaction. The naive approach —
/// putting `PRAGMA foreign_keys = OFF` at the start of a migration SQL and
/// `ON` at the end — silently fails to take effect once we wrap the migration
/// in a SAVEPOINT, which means cascade-delete FKs (like `tabs.workspace_id
/// ON DELETE CASCADE`) fire during table-rebuild migrations and silently
/// destroy data. To avoid this, we extract leading and trailing PRAGMA
/// `foreign_keys` statements from the migration SQL and execute them outside
/// the SAVEPOINT. The schema-changing part of the migration runs inside.
fn apply_one(conn: &Connection, name: &str, sql: &str) -> Result<(), rusqlite::Error> {
    let (prefix_pragmas, body, suffix_pragmas) = split_fk_pragmas(sql);

    if !prefix_pragmas.is_empty() {
        conn.execute_batch(&prefix_pragmas)?;
    }

    conn.execute_batch("SAVEPOINT migration;")?;

    let result: Result<(), rusqlite::Error> = (|| {
        conn.execute_batch(&body)?;
        conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])?;
        Ok(())
    })();

    if result.is_err() {
        conn.execute_batch("ROLLBACK TO migration; RELEASE migration;")
            .ok();
        // Restore default FK enforcement on failure too — otherwise a failed
        // migration that ran the prefix PRAGMA would leave FK enforcement off
        // for the rest of the app lifetime.
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        return result;
    }

    conn.execute_batch("RELEASE migration;")?;

    if !suffix_pragmas.is_empty() {
        conn.execute_batch(&suffix_pragmas)?;
    }

    Ok(())
}

/// Splits a migration SQL string into three parts: leading `PRAGMA
/// foreign_keys = ...` statements, the body (everything else), and trailing
/// `PRAGMA foreign_keys = ...` statements. A statement is considered a
/// foreign-keys PRAGMA only if its first non-whitespace, non-comment token
/// matches case-insensitively. Comments and blank lines bookending the SQL
/// are kept with the body.
fn split_fk_pragmas(sql: &str) -> (String, String, String) {
    // Split on `;` to get rough statements. SQLite allows multiline statements
    // and we don't need a full parser — migrations don't include semicolons
    // inside string literals (we control the SQL).
    let raw: Vec<&str> = sql.split(';').collect();

    let is_fk_pragma = |stmt: &str| {
        let trimmed = stmt
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_lowercase();
        trimmed.starts_with("pragma foreign_keys")
    };

    // Find the index of the first non-FK-PRAGMA statement (start of body) and
    // the index after the last non-FK-PRAGMA statement (end of body).
    let mut body_start = 0usize;
    while body_start < raw.len() && raw[body_start].trim().is_empty() {
        body_start += 1;
    }
    while body_start < raw.len() && is_fk_pragma(raw[body_start]) {
        body_start += 1;
    }
    let mut body_end = raw.len();
    while body_end > body_start && raw[body_end - 1].trim().is_empty() {
        body_end -= 1;
    }
    while body_end > body_start && is_fk_pragma(raw[body_end - 1]) {
        body_end -= 1;
    }

    let join_with_semicolons = |parts: &[&str]| -> String {
        let mut out = String::new();
        for p in parts {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                continue;
            }
            out.push_str(trimmed);
            out.push_str(";\n");
        }
        out
    };

    let prefix = join_with_semicolons(&raw[..body_start]);
    let body = raw[body_start..body_end].join(";");
    let suffix = join_with_semicolons(&raw[body_end..]);

    (prefix, body, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn
    }

    #[test]
    fn run_migrations_succeeds() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
    }

    #[test]
    fn run_migrations_is_idempotent() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();
    }

    #[test]
    fn workspaces_table_exists() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn tabs_table_exists() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM tabs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn migrations_table_has_entries() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 13);
    }

    #[test]
    fn env_bundle_and_var_tables_exist() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        for table in ["workspace_env_bundles", "workspace_env_vars"] {
            let count: i32 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} should exist and be empty");
        }
    }

    #[test]
    fn workspaces_has_no_env_json_column() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(workspaces)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect();
        assert!(
            !cols.iter().any(|c| c == "env_json"),
            "013 should have dropped env_json, got {cols:?}"
        );
    }

    /// Only one Bundle per Workspace may be injected. The partial unique index
    /// is what enforces it — without it, two injected Bundles would silently
    /// both land in a spawned PTY's environment.
    #[test]
    fn only_one_injected_bundle_per_workspace() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        seed_workspace(&conn, "ws-1");

        conn.execute(
            "INSERT INTO workspace_env_bundles (id, workspace_id, name, injected) VALUES ('b1', 'ws-1', 'default', 1)",
            [],
        )
        .unwrap();
        let second = conn.execute(
            "INSERT INTO workspace_env_bundles (id, workspace_id, name, injected) VALUES ('b2', 'ws-1', 'production', 1)",
            [],
        );
        assert!(second.is_err(), "a second injected bundle must be rejected");

        // Non-injected siblings are fine, and so is an injected bundle in a
        // different Workspace.
        conn.execute(
            "INSERT INTO workspace_env_bundles (id, workspace_id, name, injected) VALUES ('b3', 'ws-1', 'production', 0)",
            [],
        )
        .unwrap();
    }

    /// Deleting a Workspace must cascade two levels: bundles, then their vars.
    #[test]
    fn env_vars_cascade_two_levels_on_workspace_delete() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        seed_workspace(&conn, "ws-1");

        conn.execute(
            "INSERT INTO workspace_env_bundles (id, workspace_id, name, injected) VALUES ('b1', 'ws-1', 'default', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace_env_vars (id, bundle_id, name, nonce, ciphertext) VALUES ('v1', 'b1', 'TOKEN', X'00', X'00')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM workspaces WHERE id = 'ws-1'", [])
            .unwrap();

        let bundles: i32 = conn
            .query_row("SELECT COUNT(*) FROM workspace_env_bundles", [], |r| r.get(0))
            .unwrap();
        let vars: i32 = conn
            .query_row("SELECT COUNT(*) FROM workspace_env_vars", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bundles, 0, "bundles should cascade from workspaces");
        assert_eq!(vars, 0, "vars should cascade from bundles");
    }

    fn seed_workspace(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder, position, profile_id)
             VALUES (?1, 'W', '/tmp', 0, '00000000-0000-0000-0000-000000000001')",
            [id],
        )
        .unwrap();
    }

    /// Simulates the wedged state of users who ran the original buggy 008:
    /// their workspaces exist but every tab was cascade-deleted. After all
    /// migrations apply, every workspace must have at least one tab again.
    #[test]
    fn migration_009_backfills_default_tab_for_tabless_workspaces() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        // Simulate the wedged state: profile exists, workspace exists, no
        // tabs. (Real users got here via the FK cascade; we just delete the
        // tabs directly for the test.)
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'Survivor', '/tmp')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM tabs WHERE workspace_id = 'w1'", [])
            .unwrap();
        // Pretend 009 hasn't run yet so we can re-apply it.
        conn.execute(
            "DELETE FROM _migrations WHERE name = '009_recover_lost_tabs'",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let tab_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM tabs WHERE workspace_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tab_count, 1, "Each tabless workspace gets exactly one tab");

        let layout: String = conn
            .query_row(
                "SELECT layout_json FROM tabs WHERE workspace_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The recovered layout must be valid JSON describing a terminal pane
        // with a non-"default" pane id.
        assert!(layout.contains("\"type\":\"terminal\""));
        assert!(!layout.contains("\"id\":\"default\""));
    }

    #[test]
    fn profiles_table_exists_with_default() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let name: String = conn
            .query_row("SELECT name FROM profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Default");
    }

    #[test]
    fn workspaces_have_profile_id_column() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        // Inserting a workspace without specifying profile_id should use the default
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'Test', '/tmp')",
            [],
        )
        .unwrap();
        let profile_id: String = conn
            .query_row(
                "SELECT profile_id FROM workspaces WHERE id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(profile_id, "00000000-0000-0000-0000-000000000001");
    }

    #[test]
    fn deleting_profile_cascades_to_workspaces() {
        let conn = test_db();
        run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'Test', '/tmp')",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM profiles WHERE id = '00000000-0000-0000-0000-000000000001'",
            [],
        )
        .unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    /// Simulates a DB wedged by an earlier broken 008 attempt: profiles table
    /// and Default row exist, but workspaces still has the pre-008 schema and
    /// 008 is not in _migrations. The current 008 must recover.
    #[test]
    fn migration_008_recovers_from_partial_previous_run() {
        let conn = test_db();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            )",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS.iter().take(7) {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])
                .unwrap();
        }
        // Insert a pre-existing workspace.
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'Pre', '/tmp/pre')",
            [],
        )
        .unwrap();
        // Simulate the partial state left by the previous broken 008:
        // profiles table + Default row created, but workspaces not rebuilt
        // and 008 not in _migrations.
        conn.execute_batch(
            "CREATE TABLE profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT INTO profiles (id, name, position) VALUES
                ('00000000-0000-0000-0000-000000000001', 'Default', 0);",
        )
        .unwrap();

        // Run all migrations — 008 should recover.
        run_migrations(&conn).unwrap();

        // workspaces row preserved with backfilled profile_id.
        let profile_id: String = conn
            .query_row(
                "SELECT profile_id FROM workspaces WHERE id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(profile_id, "00000000-0000-0000-0000-000000000001");
        // Profiles table still has exactly one Default row.
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        // 008 is now in _migrations.
        let applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = '008_add_profiles')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(applied);
    }

    /// Regression test for the bug where migration 008's PRAGMA foreign_keys
    /// = OFF was silently ignored inside the apply_one SAVEPOINT, causing
    /// DROP TABLE workspaces to cascade-delete every tab via the existing
    /// tabs.workspace_id ON DELETE CASCADE FK. After the fix, tabs survive
    /// the workspaces table rebuild.
    #[test]
    fn migration_008_preserves_tabs() {
        let conn = test_db();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            )",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS.iter().take(7) {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])
                .unwrap();
        }
        // Insert a workspace AND a tab under the pre-008 schema.
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('w1', 'WS', '/tmp/ws')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tabs (id, workspace_id, name, layout_json, position) \
             VALUES ('t1', 'w1', 'Terminal 1', '{}', 0)",
            [],
        )
        .unwrap();

        // Now run all migrations — 008 must not cascade-delete the tab.
        run_migrations(&conn).unwrap();

        let tab_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM tabs WHERE workspace_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            tab_count, 1,
            "Migration 008 must preserve tabs across the workspaces table rebuild"
        );
    }

    /// Simulates an existing production DB at migration version 7 with rows
    /// already in workspaces, then runs the 008 migration and verifies the
    /// rows are preserved and assigned to the default profile. This is the
    /// scenario that exposed the original "Cannot add a REFERENCES column
    /// with non-NULL default value" bug.
    #[test]
    fn migration_008_backfills_existing_workspaces() {
        let conn = test_db();
        // Create the migrations bookkeeping table and run only migrations 1..=7
        // manually so 008 runs against a populated workspaces table — the
        // scenario that exposed the original FK/default bug.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            )",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS.iter().take(7) {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])
                .unwrap();
        }
        // Insert a workspace under the pre-profile schema.
        conn.execute(
            "INSERT INTO workspaces (id, name, root_folder) VALUES ('legacy', 'OldWS', '/tmp/legacy')",
            [],
        )
        .unwrap();

        // Now run all migrations (which will only run 008 since 1..=7 are marked applied).
        run_migrations(&conn).unwrap();

        let profile_id: String = conn
            .query_row(
                "SELECT profile_id FROM workspaces WHERE id = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(profile_id, "00000000-0000-0000-0000-000000000001");

        // Profile cascade still works on the post-migration table.
        conn.execute(
            "DELETE FROM profiles WHERE id = '00000000-0000-0000-0000-000000000001'",
            [],
        )
        .unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

pub fn open_db() -> Result<Connection, rusqlite::Error> {
    // On first run of this data epoch, seed it from the previous version's
    // database (a copy, so older builds keep working — see app_paths.rs).
    // Idempotent; the second and third `open_db` at startup are no-ops.
    crate::app_paths::import_legacy_state_if_needed();

    let db_path = crate::app_paths::db_path();
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    run_migrations(&conn)?;

    Ok(conn)
}

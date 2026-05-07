use rusqlite::Connection;
use std::path::Path;

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
            conn.execute_batch(sql)?;
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])?;
            log::info!("Applied migration: {}", name);
        }
    }

    Ok(())
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
        assert_eq!(count, 7);
    }
}

pub fn open_db() -> Result<Connection, rusqlite::Error> {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| Path::new("~").to_path_buf())
        .join("abundio");

    std::fs::create_dir_all(&data_dir).ok();

    let db_path = data_dir.join("abundio.db");
    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    run_migrations(&conn)?;

    Ok(conn)
}

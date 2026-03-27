use rusqlite::Connection;
use std::path::Path;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_init", include_str!("../migrations/001_init.sql")),
    ("002_add_tabs", include_str!("../migrations/002_add_tabs.sql")),
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

//! Where Abundio keeps its state on disk.
//!
//! State is split in two:
//!
//! * **Shared** (`<data>/abundio/`) — things that describe the machine rather
//!   than one Abundio build: the agent hook relay scripts and shims. These are
//!   version-independent by construction (the relay reads its port and token
//!   from the pane's environment at fire time), and duplicating them would mean
//!   provisioning the user's global agent config twice.
//!
//! * **Versioned** (`<data>/abundio/<DATA_EPOCH>/`) — the database, PTY
//!   scrollback logs, the shell-integration wrapper scripts and the window
//!   restore file.
//!
//! ## Why the versioned split exists
//!
//! Migration 013 drops `workspaces.env_json`, so an older binary's
//! `workspace_list` query fails outright against a migrated database. Without a
//! split, installing this version would make every older version unusable — you
//! could not keep a known-good build around to fall back to.
//!
//! The database is not the only conflict, and the others are subtler:
//!
//! * `shell-integration/` is rewritten unconditionally by whichever process
//!   spawns a terminal first. An older build's wrapper scripts have no
//!   `ABUNDIO_ENV_KEYS` re-export block, so it would silently disable this
//!   version's environment injection — with no error anywhere.
//! * `pty-logs/` is keyed by pane id. Because the new database starts as a copy
//!   of the old one, both builds would hold the *same* pane ids and interleave
//!   writes into the same log file.
//! * `windows.json` would have the two builds overwriting each other's window
//!   restore state on quit.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// Bumped only when a schema change makes older builds unable to read the
/// database. Not the app version — several app versions share one epoch.
pub const DATA_EPOCH: &str = "v2";

/// State shared with every other installed Abundio version.
pub fn shared_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| Path::new("~").to_path_buf())
        .join("abundio")
}

/// State private to builds of this data epoch.
pub fn versioned_root() -> PathBuf {
    shared_root().join(DATA_EPOCH)
}

pub fn db_path() -> PathBuf {
    versioned_root().join("abundio.db")
}

/// The pre-epoch database, which older builds still use. Read only once, to
/// seed this epoch — never written to.
pub fn legacy_db_path() -> PathBuf {
    shared_root().join("abundio.db")
}

pub fn pty_logs_dir() -> PathBuf {
    versioned_root().join("pty-logs")
}

fn legacy_pty_logs_dir() -> PathBuf {
    shared_root().join("pty-logs")
}

pub fn shell_integration_dir() -> PathBuf {
    versioned_root().join("shell-integration")
}

pub fn windows_json_path() -> PathBuf {
    versioned_root().join("windows.json")
}

/// Agent hook relay scripts. Deliberately SHARED — see the module docs.
pub fn hooks_dir() -> PathBuf {
    shared_root().join("hooks")
}

/// Seed this epoch's state from the pre-epoch layout, once, on first run.
///
/// Copies rather than moves: the older build keeps working against its own
/// database, which is the entire point. Idempotent and safe to call from every
/// `open_db`, guarded both by a `OnceLock` and by the target's existence.
pub fn import_legacy_state_if_needed() {
    static IMPORTED: OnceLock<()> = OnceLock::new();
    IMPORTED.get_or_init(|| {
        let target = db_path();
        if target.exists() {
            return;
        }
        let legacy = legacy_db_path();
        if !legacy.exists() {
            // Fresh install: nothing to import.
            return;
        }

        if let Err(e) = std::fs::create_dir_all(versioned_root()) {
            log::error!("[paths] could not create {DATA_EPOCH} data dir: {e}");
            return;
        }

        match copy_database(&legacy, &target) {
            Ok(()) => log::info!(
                "[paths] seeded {DATA_EPOCH} database from the previous version's data"
            ),
            Err(e) => {
                log::error!("[paths] could not import the previous database: {e}");
                // Leave no half-written file behind — a fresh, empty database is
                // recoverable, a truncated one is not. The sidecars matter too:
                // `Connection::open` may have created them before the copy
                // failed, and orphaned WAL/SHM alongside a fresh target on the
                // next attempt is an avoidable state.
                remove_database_files(&target);
                return;
            }
        }

        // Scrollback follows the pane ids we just copied, so bring the logs too.
        // Best-effort: losing scrollback is a cosmetic regression, not a failure.
        if let Err(e) = copy_dir_shallow(&legacy_pty_logs_dir(), &pty_logs_dir()) {
            log::warn!("[paths] could not copy PTY scrollback logs: {e}");
        }
    });
}

/// Remove a database and its WAL/SHM sidecars.
fn remove_database_files(db: &Path) {
    let _ = std::fs::remove_file(db);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = db.as_os_str().to_os_string();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(sidecar));
    }
}

/// Copy a SQLite database using the backup API.
///
/// Not a file copy: the source is in WAL mode, so its `.db` alone is missing
/// everything still in the `-wal`. The backup API produces a consistent
/// snapshot including uncheckpointed WAL frames, and the source is opened
/// READ_ONLY so a running older build cannot be disturbed.
fn copy_database(src: &Path, dst: &Path) -> Result<(), rusqlite::Error> {
    let source = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut target = Connection::open(dst)?;
    let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
    backup.run_to_completion(100, Duration::from_millis(0), None)?;
    Ok(())
}

/// Copy the files directly inside `from` into `to`. Not recursive — the only
/// caller is the flat `pty-logs` directory.
fn copy_dir_shallow(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versioned_paths_live_under_the_shared_root() {
        let shared = shared_root();
        for path in [
            db_path(),
            pty_logs_dir(),
            shell_integration_dir(),
            windows_json_path(),
        ] {
            assert!(path.starts_with(&shared), "{path:?} escaped the data dir");
            assert!(
                path.to_string_lossy().contains(DATA_EPOCH),
                "{path:?} is not epoch-scoped, so an older build would fight over it"
            );
        }
    }

    /// The legacy database and the hook relay scripts must NOT be epoch-scoped:
    /// the first is what we import from, the second is deliberately shared.
    #[test]
    fn shared_paths_are_not_epoch_scoped() {
        for path in [legacy_db_path(), hooks_dir()] {
            assert!(
                !path.to_string_lossy().contains(&format!("/{DATA_EPOCH}/")),
                "{path:?} should be shared across versions"
            );
        }
    }

    #[test]
    fn legacy_and_current_database_paths_differ() {
        assert_ne!(db_path(), legacy_db_path());
    }

    #[test]
    fn copy_database_produces_a_readable_independent_copy() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.db");
        let dst = dir.path().join("dst.db");

        {
            let conn = Connection::open(&src).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
                 INSERT INTO t (v) VALUES ('one'), ('two');",
            )
            .unwrap();
            // Deliberately NOT checkpointed: rows still live in the -wal, which
            // is exactly the case a plain file copy would lose.
        }

        copy_database(&src, &dst).unwrap();

        let copy = Connection::open(&dst).unwrap();
        let count: i64 = copy
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "uncheckpointed WAL rows must survive the copy");

        // Writing to the copy must not affect the source.
        copy.execute("INSERT INTO t (v) VALUES ('three')", []).unwrap();
        let source = Connection::open(&src).unwrap();
        let src_count: i64 = source
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_count, 2, "the older version's database must be untouched");
    }

    /// Exercises the real import against a sandboxed copy of the user's data
    /// directory. Ignored by default — it reads the live legacy database.
    /// `cargo test import_from_real_data_dir -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn import_from_real_data_dir() {
        let legacy = legacy_db_path();
        if !legacy.exists() {
            println!("no legacy database; nothing to probe");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("abundio.db");
        copy_database(&legacy, &target).expect("import should succeed");

        let conn = Connection::open(&target).unwrap();
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        let ws: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        let tabs: i64 = conn
            .query_row("SELECT COUNT(*) FROM tabs", [], |r| r.get(0))
            .unwrap();
        println!("imported copy: integrity={integrity} workspaces={ws} tabs={tabs}");
        assert_eq!(integrity, "ok");
        assert!(ws > 0);
    }

    #[test]
    fn copy_dir_shallow_copies_files_and_tolerates_a_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");

        // Missing source is not an error — a fresh install has no logs.
        assert!(copy_dir_shallow(&from, &to).is_ok());

        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.log"), b"hello").unwrap();
        std::fs::create_dir_all(from.join("nested")).unwrap();

        copy_dir_shallow(&from, &to).unwrap();
        assert_eq!(std::fs::read(to.join("a.log")).unwrap(), b"hello");
        assert!(!to.join("nested").exists(), "copy is intentionally shallow");
    }
}


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
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// Bumped only when a schema change makes older builds unable to read the
/// database, or when a line of work must not touch the one in daily use. Not
/// the app version — several app versions share one epoch.
///
/// `v3`: remote Hosts (docs/plans/remote-hosts.md) add Joined profiles and
/// Host settings (ADR-0064) to the database, and the release in daily use
/// stays on `v2`, untouched by this work.
pub const DATA_EPOCH: &str = "v3";

/// The epoch this one's first start copies its state from.
pub const PREVIOUS_EPOCH: &str = "v2";

/// State shared with every other installed Abundio version.
pub fn shared_root() -> PathBuf {
    if let Some(root) = ROOT_OVERRIDE.get() {
        return root.clone();
    }
    dirs::data_dir()
        .unwrap_or_else(|| Path::new("~").to_path_buf())
        .join("abundio")
}

static ROOT_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Put every path under `root` instead of the platform data folder: the
/// headless server keeps its own (`~/.abundio-server/data` by default), so on
/// a Mac that also runs the app the two never share a database. Set once,
/// before anything reads a path; `false` if it was already set.
pub fn set_shared_root(root: PathBuf) -> bool {
    ROOT_OVERRIDE.set(root).is_ok()
}

/// State private to builds of this data epoch.
pub fn versioned_root() -> PathBuf {
    shared_root().join(DATA_EPOCH)
}

pub fn db_path() -> PathBuf {
    versioned_root().join("abundio.db")
}

/// The previous epoch's database, which older builds still use. Read only once, to
/// seed this epoch — never written to.
pub fn legacy_db_path() -> PathBuf {
    shared_root().join(PREVIOUS_EPOCH).join("abundio.db")
}

pub fn pty_logs_dir() -> PathBuf {
    versioned_root().join("pty-logs")
}

fn legacy_pty_logs_dir() -> PathBuf {
    shared_root().join(PREVIOUS_EPOCH).join("pty-logs")
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
/// `open_db`, guarded both by a done flag and by the target's existence.
///
/// Returns `true` once there is nothing left to do: the import succeeded, the
/// database was already in place, or there was nothing to import. Returns
/// `false` when it failed, and then it runs again on the next call. That
/// matters for the startup **Try Again** (db_startup.rs): if security software
/// blocked the first try, marking it done would let the retry create an empty
/// database, and the previous version's data would never be imported.
pub fn import_legacy_state_if_needed() -> bool {
    static DONE: Mutex<bool> = Mutex::new(false);
    let mut done = DONE.lock().unwrap_or_else(|e| e.into_inner());
    if *done {
        return true;
    }
    *done = import_legacy_state(
        &db_path(),
        &legacy_db_path(),
        &versioned_root(),
        &legacy_pty_logs_dir(),
        &pty_logs_dir(),
    );
    *done
}

/// The import itself, with its paths passed in so it tests against a temp dir.
fn import_legacy_state(
    target: &Path,
    legacy: &Path,
    root: &Path,
    logs_from: &Path,
    logs_to: &Path,
) -> bool {
    if target.exists() {
        return true;
    }
    if !legacy.exists() {
        // Fresh install: nothing to import.
        return true;
    }

    if let Err(e) = std::fs::create_dir_all(root) {
        log::error!("[paths] could not create {DATA_EPOCH} data dir: {e}");
        return false;
    }

    match copy_database(legacy, target) {
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
            remove_database_files(target);
            return false;
        }
    }

    // Scrollback follows the pane ids we just copied, so bring the logs too.
    // Best-effort: losing scrollback is a cosmetic regression, not a failure.
    if let Err(e) = copy_dir_shallow(logs_from, logs_to) {
        log::warn!("[paths] could not copy PTY scrollback logs: {e}");
    }
    // And the Windows to reopen. Best-effort too: a missing one opens a
    // default Window.
    if let (Some(from), Some(to)) = (legacy.parent(), target.parent()) {
        let _ = std::fs::copy(from.join("windows.json"), to.join("windows.json"));
    }
    true
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

    /// The previous epoch's database and the hook relay scripts must NOT be in
    /// this epoch: the first is what we import from, the second is
    /// deliberately shared.
    #[test]
    fn shared_paths_are_not_epoch_scoped() {
        for path in [legacy_db_path(), hooks_dir()] {
            assert!(
                !path.to_string_lossy().contains(&format!("/{DATA_EPOCH}/")),
                "{path:?} should be shared across versions"
            );
        }
    }

    /// A new epoch's first start: the previous epoch's database, logs and
    /// Windows are copied; the previous epoch's own stay as they were.
    #[test]
    fn a_new_epoch_starts_as_a_copy_of_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("v2"), dir.path().join("v3"));
        std::fs::create_dir_all(old.join("pty-logs")).unwrap();
        {
            let c = Connection::open(old.join("abundio.db")).unwrap();
            c.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (7);").unwrap();
        }
        std::fs::write(old.join("pty-logs/pane.log"), "scrollback").unwrap();
        std::fs::write(old.join("windows.json"), "[]").unwrap();
        assert!(import_legacy_state(
            &new.join("abundio.db"),
            &old.join("abundio.db"),
            &new,
            &old.join("pty-logs"),
            &new.join("pty-logs"),
        ));
        let c = Connection::open(new.join("abundio.db")).unwrap();
        let x: i64 = c.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 7);
        assert_eq!(std::fs::read_to_string(new.join("pty-logs/pane.log")).unwrap(), "scrollback");
        assert_eq!(std::fs::read_to_string(new.join("windows.json")).unwrap(), "[]");
        // The previous epoch's own files are where they were.
        assert!(old.join("abundio.db").exists() && old.join("windows.json").exists());
        assert!(legacy_db_path().to_string_lossy().contains(&format!("/{PREVIOUS_EPOCH}/")));
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

    #[test]
    fn import_reports_a_failed_copy_so_it_can_run_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("v2");
        let target = root.join("abundio.db");
        let legacy = dir.path().join("legacy.db");
        let logs_from = dir.path().join("logs-old");
        let logs_to = root.join("pty-logs");

        // Not a database: the copy fails, and no half-written target is left.
        std::fs::write(&legacy, b"not a sqlite file").unwrap();
        assert!(!import_legacy_state(&target, &legacy, &root, &logs_from, &logs_to));
        assert!(!target.exists());

        // Once the legacy database is readable, the next call imports it.
        std::fs::remove_file(&legacy).unwrap();
        {
            let conn = Connection::open(&legacy).unwrap();
            conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');")
                .unwrap();
        }
        assert!(import_legacy_state(&target, &legacy, &root, &logs_from, &logs_to));
        let v: String = Connection::open(&target)
            .unwrap()
            .query_row("SELECT v FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "kept");
    }

    #[test]
    fn import_is_done_when_there_is_nothing_to_import() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("v2");
        let target = root.join("abundio.db");
        let legacy = dir.path().join("missing.db");
        let logs = dir.path().join("logs");
        assert!(import_legacy_state(&target, &legacy, &root, &logs, &logs));
        assert!(!target.exists());
    }
}


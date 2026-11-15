//! Opening the database at app start without crashing when it can't be opened.
//!
//! Security software, a full disk or folder permissions can stop the database
//! from opening. Before this module every startup `open_db` was an `expect`,
//! so the app panicked with no window and no message. Now:
//!
//! 1. SQLite waits out short locks itself (`BUSY_TIMEOUT`, set in `open_db`).
//! 2. The open is retried quietly for a few seconds (`open_with_retries`).
//! 3. If it still fails, a native dialog explains why and offers Try Again or
//!    Quit. The database is never deleted, reset or moved here.

use rusqlite::Connection;
use std::path::PathBuf;
use std::time::Duration;

/// How long SQLite waits on a locked database before giving up on a statement.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Quiet retries before the user is asked: 5 tries, one second apart.
const QUIET_ATTEMPTS: u32 = 5;
const QUIET_DELAY: Duration = Duration::from_secs(1);

const TRY_AGAIN: &str = "Try Again";
const QUIT: &str = "Quit";

/// Which step of opening the database failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbOpenStage {
    /// Creating the folder that holds the database.
    Folder,
    /// Opening or creating the database file, or setting it up.
    Open,
    /// Bringing the database up to date (a migration failed).
    Migrate,
}

#[derive(Debug, Clone)]
pub struct DbOpenError {
    pub stage: DbOpenStage,
    pub path: PathBuf,
    pub message: String,
}

impl std::fmt::Display for DbOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.stage {
            DbOpenStage::Folder => "could not create the database folder",
            DbOpenStage::Open => "could not open the database",
            DbOpenStage::Migrate => "could not upgrade the database",
        };
        write!(f, "{what} at {}: {}", self.path.display(), self.message)
    }
}

impl std::error::Error for DbOpenError {}

/// The dialog's title and body for a failure.
pub fn failure_message(err: &DbOpenError) -> (String, String) {
    let (title, lead) = match err.stage {
        DbOpenStage::Folder => (
            "Abundio could not create its data folder",
            "Abundio could not create the folder that holds its database.",
        ),
        DbOpenStage::Open => (
            "Abundio could not open its database",
            "Abundio could not open or create its database.",
        ),
        DbOpenStage::Migrate => (
            "Abundio could not upgrade its database",
            "Abundio opened its database but could not bring it up to date. \
             Your data has not been changed or deleted.",
        ),
    };
    let body = format!(
        "{lead}\n\n\
         Security software, a full disk, or folder permissions can cause this. \
         If your antivirus is blocking Abundio, allow it and choose {TRY_AGAIN}.\n\n\
         Database: {}\n\
         Error: {}",
        err.path.display(),
        err.message,
    );
    (title.to_string(), body)
}

/// Runs `open` up to `attempts` times, calling `sleep` between tries.
/// Returns the first success, or the last error.
pub fn open_with_retries<T, E>(
    attempts: u32,
    mut open: impl FnMut() -> Result<T, E>,
    mut sleep: impl FnMut(),
) -> Result<T, E> {
    let mut tries = 1;
    loop {
        match open() {
            Ok(v) => return Ok(v),
            Err(e) if tries >= attempts.max(1) => return Err(e),
            Err(_) => {
                tries += 1;
                sleep();
            }
        }
    }
}

/// Quiet retries, then the dialog, until it opens or the user quits.
/// `ask` shows the failure and returns true for Try Again. Returns `None`
/// when the user chose Quit.
pub fn open_or_ask<T, E>(
    mut open: impl FnMut() -> Result<T, E>,
    mut sleep: impl FnMut(),
    mut ask: impl FnMut(&E) -> bool,
) -> Option<T> {
    loop {
        match open_with_retries(QUIET_ATTEMPTS, &mut open, &mut sleep) {
            Ok(v) => return Some(v),
            Err(e) => {
                if !ask(&e) {
                    return None;
                }
            }
        }
    }
}

/// Shows the failure in a native dialog. True means Try Again.
///
/// Uses `rfd` directly, not the dialog plugin: the plugin's `blocking_show`
/// hands the dialog to the main thread and waits for it, and `setup` already
/// runs on the main thread, so it would wait forever.
fn ask_user(err: &DbOpenError) -> bool {
    let (title, body) = failure_message(err);
    let result = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(&title)
        .set_description(&body)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            TRY_AGAIN.to_string(),
            QUIT.to_string(),
        ))
        .show();
    is_try_again(&result)
}

/// Linux reports custom buttons as plain Ok / Cancel (as the dialog plugin
/// also notes); macOS and Windows report the label.
fn is_try_again(result: &rfd::MessageDialogResult) -> bool {
    match result {
        rfd::MessageDialogResult::Custom(label) => label == TRY_AGAIN,
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => true,
        _ => false,
    }
}

/// Opens a startup database connection. If it can't, and the user chooses
/// Quit, the app exits here: nothing has started yet, so there is nothing to
/// clean up. Must run on the main thread (Tauri's `setup`).
pub fn open_db_or_quit() -> Connection {
    let conn = open_or_ask(
        || {
            crate::migrations::open_db().inspect_err(|e| {
                log::warn!("[db] {e}");
            })
        },
        || std::thread::sleep(QUIET_DELAY),
        |e| {
            log::error!("[db] giving up for now, asking the user: {e}");
            ask_user(e)
        },
    );
    match conn {
        Some(c) => c,
        None => {
            log::error!("[db] the user chose Quit after the database failed to open");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn err(stage: DbOpenStage) -> DbOpenError {
        DbOpenError {
            stage,
            path: PathBuf::from("/data/abundio/v2/abundio.db"),
            message: "unable to open database file".into(),
        }
    }

    #[test]
    fn retries_until_success() {
        let calls = Cell::new(0);
        let sleeps = Cell::new(0);
        let r: Result<u32, &str> = open_with_retries(
            5,
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Err("locked")
                } else {
                    Ok(7)
                }
            },
            || sleeps.set(sleeps.get() + 1),
        );
        assert_eq!(r, Ok(7));
        assert_eq!(calls.get(), 3);
        assert_eq!(sleeps.get(), 2);
    }

    #[test]
    fn gives_up_after_the_attempts_without_a_trailing_sleep() {
        let calls = Cell::new(0);
        let sleeps = Cell::new(0);
        let r: Result<(), &str> = open_with_retries(
            3,
            || {
                calls.set(calls.get() + 1);
                Err("locked")
            },
            || sleeps.set(sleeps.get() + 1),
        );
        assert_eq!(r, Err("locked"));
        assert_eq!(calls.get(), 3);
        assert_eq!(sleeps.get(), 2);
    }

    #[test]
    fn zero_attempts_still_tries_once() {
        let calls = Cell::new(0);
        let _: Result<(), ()> = open_with_retries(
            0,
            || {
                calls.set(calls.get() + 1);
                Err(())
            },
            || {},
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn quit_returns_none_and_asks_once() {
        let asked = Cell::new(0);
        let r: Option<()> = open_or_ask(
            || Err::<(), _>("blocked"),
            || {},
            |_| {
                asked.set(asked.get() + 1);
                false
            },
        );
        assert!(r.is_none());
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn try_again_runs_a_fresh_round_of_quiet_retries() {
        let calls = Cell::new(0);
        let asked = Cell::new(0);
        let r = open_or_ask(
            || {
                calls.set(calls.get() + 1);
                // Fails the whole first round, then opens on the next try.
                if calls.get() <= QUIET_ATTEMPTS {
                    Err("blocked")
                } else {
                    Ok("db")
                }
            },
            || {},
            |_| {
                asked.set(asked.get() + 1);
                true
            },
        );
        assert_eq!(r, Some("db"));
        assert_eq!(asked.get(), 1);
        assert_eq!(calls.get(), QUIET_ATTEMPTS + 1);
    }

    #[test]
    fn message_names_security_software_the_path_and_the_error() {
        let (title, body) = failure_message(&err(DbOpenStage::Open));
        assert_eq!(title, "Abundio could not open its database");
        assert!(body.contains("Security software"));
        assert!(body.contains("/data/abundio/v2/abundio.db"));
        assert!(body.contains("unable to open database file"));
        assert!(body.contains(TRY_AGAIN));
    }

    #[test]
    fn migration_failure_says_upgrade_and_that_data_is_untouched() {
        let (title, body) = failure_message(&err(DbOpenStage::Migrate));
        assert!(title.contains("upgrade"));
        assert!(body.contains("has not been changed or deleted"));
    }

    #[test]
    fn folder_failure_has_its_own_title() {
        let (title, _) = failure_message(&err(DbOpenStage::Folder));
        assert!(title.contains("data folder"));
    }

    #[test]
    fn try_again_is_read_from_either_platform_answer() {
        assert!(is_try_again(&rfd::MessageDialogResult::Custom(
            TRY_AGAIN.into()
        )));
        assert!(!is_try_again(&rfd::MessageDialogResult::Custom(
            QUIT.into()
        )));
        assert!(is_try_again(&rfd::MessageDialogResult::Ok));
        assert!(!is_try_again(&rfd::MessageDialogResult::Cancel));
    }

    #[test]
    fn display_includes_stage_path_and_message() {
        let s = err(DbOpenStage::Migrate).to_string();
        assert!(s.starts_with("could not upgrade the database at /data/abundio/v2/abundio.db"));
        assert!(s.ends_with("unable to open database file"));
    }
}

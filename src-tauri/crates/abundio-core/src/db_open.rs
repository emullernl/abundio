//! Why the database did not open, and quiet retries, with no UI: the
//! desktop app asks the user on top of this (`db_startup.rs`); the headless
//! server logs and exits.

use std::path::PathBuf;
use std::time::Duration;

/// The dialog's buttons, named in the failure message.
pub const TRY_AGAIN: &str = "Try Again";
pub const QUIT: &str = "Quit";

/// Quiet retries before the user is asked: 5 tries, one second apart.
pub const QUIET_ATTEMPTS: u32 = 5;

pub const QUIET_DELAY: Duration = Duration::from_secs(1);

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
    let blocked_hint = format!(
        "Security software, a full disk, or folder permissions can cause this. \
         If your antivirus is blocking Abundio, allow it and choose {TRY_AGAIN}."
    );
    let (title, lead, hint) = match err.stage {
        DbOpenStage::Folder => (
            "Abundio could not create its data folder",
            "Abundio could not create the folder that holds its database.",
            blocked_hint,
        ),
        DbOpenStage::Open => (
            "Abundio could not open its database",
            "Abundio could not open or create its database.",
            blocked_hint,
        ),
        // Each migration commits on its own, so earlier ones from this run
        // may have been applied; only the failing one is rolled back.
        DbOpenStage::Migrate => (
            "Abundio could not upgrade its database",
            "Abundio opened its database but could not bring it up to date. \
             Nothing has been deleted; the update that failed was undone.",
            "This is unlikely to be caused by security software. If it keeps \
             happening, update Abundio or report the error below."
                .to_string(),
        ),
    };
    let body = format!(
        "{lead}\n\n\
         {hint}\n\n\
         Database: {}\n\
         Error: {}",
        err.path.display(),
        err.message,
    );
    (title.to_string(), body)
}

/// Runs `open` up to `attempts` times, calling `sleep` between tries.
/// Returns the first success, or the last error. An error `retryable` says
/// no to is returned at once.
pub fn open_with_retries<T, E>(
    attempts: u32,
    mut open: impl FnMut() -> Result<T, E>,
    mut sleep: impl FnMut(),
    retryable: impl Fn(&E) -> bool,
) -> Result<T, E> {
    let mut tries = 1;
    loop {
        match open() {
            Ok(v) => return Ok(v),
            Err(e) if tries >= attempts.max(1) || !retryable(&e) => return Err(e),
            Err(_) => {
                tries += 1;
                sleep();
            }
        }
    }
}

/// A failed migration is almost always the same on the next try (bad SQL, a
/// constraint), and SQLite's busy timeout already waited out any lock, so
/// quiet retries would only delay the dialog.
pub fn is_quietly_retryable(err: &DbOpenError) -> bool {
    err.stage != DbOpenStage::Migrate
}

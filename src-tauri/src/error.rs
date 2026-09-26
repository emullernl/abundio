use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AbundioError {
    #[error("PTY error: {0}")]
    Pty(String),
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Channel error: {0}")]
    Channel(String),
    #[error("Watcher error: {0}")]
    Watcher(String),
    #[error("Git error: {0}")]
    Git(String),
    #[error("Not a git repository: {0}")]
    NotGitRepo(String),
    #[error("Font enumeration error: {0}")]
    Font(String),
    #[error("Search error: {0}")]
    Search(String),
    #[error("Invalid operation: {0}")]
    InvalidOperation(String),
    #[error("Clipboard error: {0}")]
    Clipboard(String),
    /// An update check was refused because a download is in flight. The
    /// `E_UPDATE_DOWNLOADING` prefix is a stable code the frontend matches on
    /// (`UPDATE_DOWNLOADING_CODE` in updateStore.ts) — keep it when rewording.
    #[error("E_UPDATE_DOWNLOADING: an update is already downloading")]
    UpdateDownloading,
    /// An upstream asked us to back off. `wait` is how long the caller should
    /// refuse to retry for; it never reaches the frontend (only `message` does),
    /// but the release-notes cache reads it to size its negative entry.
    #[error("{message}")]
    RateLimited {
        message: String,
        wait: std::time::Duration,
    },
    /// Environment-variable crypto or credential-store failure. The message is
    /// deliberately coarse — it is serialized straight to the frontend, so it
    /// must never carry plaintext or key material.
    #[error("Crypto error: {0}")]
    Crypto(String),
}

impl Serialize for AbundioError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend recognises this refusal by its code, so the code is a
    /// contract. See `UPDATE_DOWNLOADING_CODE` in src/stores/updateStore.ts.
    #[test]
    fn update_downloading_display_carries_its_code() {
        assert!(AbundioError::UpdateDownloading
            .to_string()
            .starts_with("E_UPDATE_DOWNLOADING:"));
    }

    #[test]
    fn pty_error_display() {
        let err = AbundioError::Pty("spawn failed".into());
        assert_eq!(err.to_string(), "PTY error: spawn failed");
    }

    #[test]
    fn not_found_display() {
        let err = AbundioError::NotFound("workspace xyz".into());
        assert_eq!(err.to_string(), "Not found: workspace xyz");
    }

    #[test]
    fn channel_error_display() {
        let err = AbundioError::Channel("closed".into());
        assert_eq!(err.to_string(), "Channel error: closed");
    }

    #[test]
    fn serialize_to_string() {
        let err = AbundioError::Pty("test".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"PTY error: test\"");
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let err: AbundioError = io_err.into();
        assert!(err.to_string().contains("file missing"));
    }

    #[test]
    fn from_rusqlite_error() {
        let db_err = rusqlite::Error::QueryReturnedNoRows;
        let err: AbundioError = db_err.into();
        assert!(err.to_string().contains("Database error"));
    }
}

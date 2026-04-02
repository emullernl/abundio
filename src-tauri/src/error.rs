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
    #[error("Font enumeration error: {0}")]
    Font(String),
}

impl Serialize for AbundioError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_error_display() {
        let err = AbundioError::Pty("spawn failed".into());
        assert_eq!(err.to_string(), "PTY error: spawn failed");
    }

    #[test]
    fn not_found_display() {
        let err = AbundioError::NotFound("session xyz".into());
        assert_eq!(err.to_string(), "Not found: session xyz");
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

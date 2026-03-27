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
}

impl Serialize for AbundioError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

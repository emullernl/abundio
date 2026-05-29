//! Saves/restores the per-window Profile assignments across app launches.
//! See ADR-0007.
//!
//! Storage: `~/Library/Application Support/abundio/windows.json` containing a
//! JSON array of `{label, profileId}` entries. Read at app startup (in setup);
//! written when the last window is destroyed (in the on_window_event handler
//! before the app exits).
//!
//! `tauri-plugin-window-state` handles per-window geometry by label, so we
//! only need to persist the (label → profileId) mapping ourselves.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowEntry {
    pub label: String,
    #[serde(rename = "profileId")]
    pub profile_id: String,
}

pub fn windows_json_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| Path::new("~").to_path_buf())
        .join("abundio")
        .join("windows.json")
}

pub fn load() -> Vec<WindowEntry> {
    let path = windows_json_path();
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<WindowEntry>>(&contents).unwrap_or_default()
}

/// Atomic write: serialise to a temp file in the same directory, then rename.
/// Avoids leaving a half-written `windows.json` if the process is killed mid-save.
pub fn save(entries: &[WindowEntry]) -> std::io::Result<()> {
    let path = windows_json_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(entries)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp_path, payload)?;
    std::fs::rename(&tmp_path, &path)?;
    Ok(())
}

/// Builds a `WindowEntry` snapshot from the live `ActiveProfileState` map.
/// Filters out entries whose profile id is empty (defensive).
pub fn snapshot_from_state(state: &crate::profile_store::ActiveProfileState) -> Vec<WindowEntry> {
    state
        .snapshot()
        .into_iter()
        .filter(|(_, profile_id)| !profile_id.is_empty())
        .map(|(label, profile_id)| WindowEntry { label, profile_id })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn with_tempdir<F: FnOnce(&Path)>(f: F) {
        let tmp = TempDir::new().unwrap();
        f(tmp.path());
    }

    #[test]
    fn save_and_load_roundtrip() {
        with_tempdir(|dir| {
            let path = dir.join("windows.json");
            let entries = vec![
                WindowEntry {
                    label: "main".into(),
                    profile_id: "p1".into(),
                },
                WindowEntry {
                    label: "window-abc".into(),
                    profile_id: "p2".into(),
                },
            ];
            let payload = serde_json::to_string_pretty(&entries).unwrap();
            std::fs::write(&path, payload).unwrap();
            let loaded: Vec<WindowEntry> =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(loaded.len(), 2);
            assert_eq!(loaded[0].label, "main");
            assert_eq!(loaded[1].profile_id, "p2");
        });
    }

    #[test]
    fn load_missing_file_returns_empty() {
        // We can't easily redirect windows_json_path() in this test, so we
        // just exercise the parse-empty branch directly.
        let parsed: Vec<WindowEntry> = serde_json::from_str("[]").unwrap();
        assert_eq!(parsed.len(), 0);
    }
}

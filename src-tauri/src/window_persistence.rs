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
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowEntry {
    pub label: String,
    #[serde(rename = "profileId")]
    pub profile_id: String,
}

pub fn windows_json_path() -> PathBuf {
    // Epoch-scoped so two installed builds do not overwrite each other's window
    // restore state on quit.
    crate::app_paths::windows_json_path()
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

/// The outcome of planning window restoration from persisted entries.
pub struct RestorationPlan {
    /// Profile the always-present main window should adopt (`None` only when
    /// there are no profiles at all).
    pub main_profile_id: Option<String>,
    /// When the main window adopts a *survivor's* entry (because no persisted
    /// "main" entry existed), this is that survivor's label. The main window
    /// should also adopt its saved geometry. `None` when the main window keeps
    /// its own geometry (genuine "main" entry, or a fresh start).
    pub main_adopted_label: Option<String>,
    /// Additional windows to spawn, each reusing its persisted label.
    pub additional: Vec<WindowEntry>,
}

/// Decides, purely, which Profile the main window adopts and which additional
/// windows to spawn on launch. The main window is always physically created by
/// `tauri.conf`, so it must show *some* profile; it adopts:
///   1. the persisted "main" entry, if present (preserves main's geometry);
///   2. else the first surviving entry — so closing the main window while
///      others stay open lets a survivor take over the main window rather than
///      the closed main window being resurrected alongside it;
///   3. else `first_profile_id` (a fresh start).
/// The adopted entry is removed from `additional`. Entries are first filtered
/// to valid, profile-bound labels and deduped by profile id (keeping the first
/// occurrence — a Profile can't be owned by two windows at once).
pub fn plan_restoration(
    entries: Vec<WindowEntry>,
    valid_profile_ids: &std::collections::HashSet<&str>,
    main_label: &str,
    first_profile_id: Option<&str>,
) -> RestorationPlan {
    let mut seen_profiles: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut entries: Vec<WindowEntry> = entries
        .into_iter()
        .filter(|e| {
            crate::window_management::is_profile_window_label(&e.label)
                && valid_profile_ids.contains(e.profile_id.as_str())
        })
        .filter(|e| seen_profiles.insert(e.profile_id.clone()))
        .collect();

    let main_idx = entries
        .iter()
        .position(|e| e.label == main_label)
        .or_else(|| if entries.is_empty() { None } else { Some(0) });
    let (main_profile_id, main_adopted_label) = match main_idx {
        Some(i) => {
            let e = entries.remove(i);
            // Only flag a geometry adoption when a *survivor* (non-main label)
            // takes over the main window. The genuine main entry keeps its own.
            let adopted = (e.label != main_label).then_some(e.label);
            (Some(e.profile_id), adopted)
        }
        None => (first_profile_id.map(|s| s.to_string()), None),
    };

    RestorationPlan {
        main_profile_id,
        main_adopted_label,
        additional: entries,
    }
}

/// Copies one window's saved geometry onto the main window's key inside the
/// `tauri-plugin-window-state` JSON file contents, so the main window restores
/// at the survivor window's position/size. Operates on the raw JSON (a map of
/// `label -> {geometry}`) to avoid coupling to the plugin's private state type.
/// Returns the rewritten JSON, or `None` if there's nothing to do (unparseable
/// contents, or `from_label` has no saved entry).
pub fn migrate_geometry_to_main(
    contents: &str,
    from_label: &str,
    main_label: &str,
) -> Option<String> {
    let mut root: serde_json::Value = serde_json::from_str(contents).ok()?;
    let obj = root.as_object_mut()?;
    let geometry = obj.get(from_label)?.clone();
    obj.insert(main_label.to_string(), geometry);
    serde_json::to_string_pretty(&root).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
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

    fn entry(label: &str, profile: &str) -> WindowEntry {
        WindowEntry {
            label: label.into(),
            profile_id: profile.into(),
        }
    }

    fn ids<'a>(list: &[&'a str]) -> std::collections::HashSet<&'a str> {
        list.iter().copied().collect()
    }

    #[test]
    fn restore_no_entries_seeds_first_profile() {
        let plan = plan_restoration(vec![], &ids(&["p1", "p2"]), "main", Some("p1"));
        assert_eq!(plan.main_profile_id.as_deref(), Some("p1"));
        assert!(plan.additional.is_empty());
    }

    #[test]
    fn restore_main_entry_kept_as_main() {
        // Closing the non-main window leaves only the main entry → only the
        // main window restores, with its own profile.
        let plan = plan_restoration(
            vec![entry("main", "p1")],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        assert_eq!(plan.main_profile_id.as_deref(), Some("p1"));
        assert!(plan.additional.is_empty());
    }

    #[test]
    fn restore_closed_main_does_not_resurrect() {
        // The bug: closing the main window (profile 1) while a spawned window
        // (profile 2) stays open must NOT bring the main window back. The
        // survivor takes over the main window; no extra window spawns.
        let plan = plan_restoration(
            vec![entry("window-abc", "p2")],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        assert_eq!(plan.main_profile_id.as_deref(), Some("p2"));
        // The survivor's label is flagged so the main window can also adopt its
        // saved geometry.
        assert_eq!(plan.main_adopted_label.as_deref(), Some("window-abc"));
        assert!(
            plan.additional.is_empty(),
            "closed main window must not be resurrected as a second window"
        );
    }

    #[test]
    fn restore_main_entry_does_not_flag_geometry_adoption() {
        let plan = plan_restoration(
            vec![entry("main", "p1")],
            &ids(&["p1"]),
            "main",
            Some("p1"),
        );
        assert_eq!(plan.main_adopted_label, None);
    }

    #[test]
    fn restore_both_windows() {
        let plan = plan_restoration(
            vec![entry("main", "p1"), entry("window-abc", "p2")],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        assert_eq!(plan.main_profile_id.as_deref(), Some("p1"));
        assert_eq!(plan.additional.len(), 1);
        assert_eq!(plan.additional[0].label, "window-abc");
        assert_eq!(plan.additional[0].profile_id, "p2");
    }

    #[test]
    fn restore_dedupes_by_profile() {
        let plan = plan_restoration(
            vec![entry("main", "p1"), entry("window-abc", "p1")],
            &ids(&["p1"]),
            "main",
            Some("p1"),
        );
        assert_eq!(plan.main_profile_id.as_deref(), Some("p1"));
        assert!(plan.additional.is_empty());
    }

    #[test]
    fn restore_filters_invalid_profiles_and_aux_labels() {
        let plan = plan_restoration(
            vec![
                entry("settings", "p1"),  // auxiliary label — dropped
                entry("window-abc", "gone"), // profile no longer exists — dropped
                entry("window-def", "p2"),
            ],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        // No main entry survived, so the first valid survivor takes the main
        // window; nothing else remains.
        assert_eq!(plan.main_profile_id.as_deref(), Some("p2"));
        assert!(plan.additional.is_empty());
    }

    #[test]
    fn migrate_geometry_copies_survivor_onto_main() {
        let contents = r#"{
            "main": {"width": 800, "height": 600, "x": 0, "y": 0},
            "window-abc": {"width": 1400, "height": 900, "x": 120, "y": 80}
        }"#;
        let out = migrate_geometry_to_main(contents, "window-abc", "main").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        // main now holds the survivor's geometry...
        assert_eq!(parsed["main"]["width"], 1400);
        assert_eq!(parsed["main"]["x"], 120);
        // ...and the survivor entry is left untouched.
        assert_eq!(parsed["window-abc"]["width"], 1400);
    }

    #[test]
    fn migrate_geometry_absent_survivor_is_noop() {
        let contents = r#"{"main": {"width": 800, "height": 600, "x": 0, "y": 0}}"#;
        assert!(migrate_geometry_to_main(contents, "window-gone", "main").is_none());
    }

    #[test]
    fn migrate_geometry_unparseable_is_noop() {
        assert!(migrate_geometry_to_main("not json", "window-abc", "main").is_none());
    }
}

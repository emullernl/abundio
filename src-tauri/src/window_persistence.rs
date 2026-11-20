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
    /// Where the window was (ADR-0051). Absent in files written before
    /// Window placement, and for a window that was never placed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<crate::window_placement::Remembered>,
    /// A Window showing a Remote profile (phase 7d): `profile_id` is then
    /// the Host's, restored apart from the local Profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<crate::remote_windows::RemoteBinding>,
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
/// Each entry carries its window's placement from `tracker`, when given.
pub fn snapshot_from_state(
    state: &crate::profile_store::ActiveProfileState,
    tracker: Option<&crate::window_frame::PlacementTracker>,
) -> Vec<WindowEntry> {
    state
        .snapshot()
        .into_iter()
        .filter(|(_, profile_id)| !profile_id.is_empty())
        .map(|(label, profile_id)| WindowEntry {
            placement: tracker.and_then(|t| t.get(&label)),
            label,
            profile_id,
            remote: None,
        })
        .collect()
}

/// An entry that keeps only a placement: the last window's, when the user
/// closed it rather than quitting. It names no Profile, so restoration skips
/// it as a window, but [`plan_restoration`] gives its placement to the main
/// window of a fresh start. `None` when there is no placement to keep.
pub fn placement_only_entry(
    label: &str,
    placement: Option<crate::window_placement::Remembered>,
) -> Option<WindowEntry> {
    placement.map(|p| WindowEntry {
        label: label.to_string(),
        profile_id: String::new(),
        placement: Some(p),
        remote: None,
    })
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
    /// The **Window placement** the main window restores to: its own entry's,
    /// the adopted survivor's, or on a fresh start the last closed window's.
    pub main_placement: Option<crate::window_placement::Remembered>,
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
///   3. else `first_profile_id` (a fresh start), at the last closed window's
///      placement if one was kept (see [`placement_only_entry`]).
/// The adopted entry is removed from `additional`. Entries are first filtered
/// to valid, profile-bound labels and deduped by profile id (keeping the first
/// occurrence — a Profile can't be owned by two windows at once).
pub fn plan_restoration(
    entries: Vec<WindowEntry>,
    valid_profile_ids: &std::collections::HashSet<&str>,
    main_label: &str,
    first_profile_id: Option<&str>,
) -> RestorationPlan {
    // A placement-only entry (the last window closed) names no Profile, so
    // the filter below drops it; keep its placement for a fresh start.
    let last_closed_placement = entries
        .iter()
        .find(|e| e.profile_id.is_empty())
        .and_then(|e| e.placement.clone());
    let mut seen_profiles: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut entries: Vec<WindowEntry> = entries
        .into_iter()
        .filter(|e| {
            e.remote.is_none()
                && crate::window_management::is_profile_window_label(&e.label)
                && valid_profile_ids.contains(e.profile_id.as_str())
        })
        .filter(|e| seen_profiles.insert(e.profile_id.clone()))
        .collect();

    let main_idx = entries
        .iter()
        .position(|e| e.label == main_label)
        .or_else(|| if entries.is_empty() { None } else { Some(0) });
    let (main_profile_id, main_adopted_label, main_placement) = match main_idx {
        Some(i) => {
            let e = entries.remove(i);
            // Only flag a geometry adoption when a *survivor* (non-main label)
            // takes over the main window. The genuine main entry keeps its own.
            let adopted = (e.label != main_label).then_some(e.label);
            (Some(e.profile_id), adopted, e.placement)
        }
        None => (first_profile_id.map(|s| s.to_string()), None, last_closed_placement),
    };

    RestorationPlan {
        main_profile_id,
        main_adopted_label,
        main_placement,
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

/// Moves a window that is still at an old default size to the new default,
/// inside the `tauri-plugin-window-state` JSON file contents. The plugin
/// saves a window's size whenever it closes, resized or not, so a saved size
/// equal to the old default (at any scale) is taken as never chosen. Any other
/// size is the user's and is kept. Sizes are logical points; the file holds
/// physical pixels, so the scale is read from the saved size itself, and must
/// be one screens use (a quarter step). Returns
/// the rewritten JSON, or `None` when there is nothing to change.
pub fn upgrade_old_default_size(
    contents: &str,
    label: &str,
    old: (f64, f64),
    new: (f64, f64),
) -> Option<String> {
    let mut root: serde_json::Value = serde_json::from_str(contents).ok()?;
    let entry = root.as_object_mut()?.get_mut(label)?.as_object_mut()?;
    let width = entry.get("width")?.as_f64()?;
    let height = entry.get("height")?.as_f64()?;
    // Scales a screen really has come in quarter steps (1, 1.25, 1.5, … 4).
    // A size of the old aspect at any other scale is one the user chose.
    let scale = ((width / old.0) * 4.0).round() / 4.0;
    let is_old = (1.0..=4.0).contains(&scale)
        && (width - old.0 * scale).abs() <= 1.0
        && (height - old.1 * scale).abs() <= 1.0;
    if !is_old {
        return None;
    }
    entry.insert("width".into(), serde_json::json!((new.0 * scale).round() as u64));
    entry.insert("height".into(), serde_json::json!((new.1 * scale).round() as u64));
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
                    placement: None,
                    remote: None,
                },
                WindowEntry {
                    label: "window-abc".into(),
                    profile_id: "p2".into(),
                    placement: None,
                    remote: None,
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
            placement: None,
            remote: None,
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

    fn placed(label: &str, profile: &str, monitor: &str) -> WindowEntry {
        let json = format!(
            r#"{{"home":{{"monitor":{{"name":"{monitor}","arrangementIndex":0}},"relX":1,"relY":2,"width":3,"height":4}}}}"#
        );
        WindowEntry { placement: Some(serde_json::from_str(&json).unwrap()), ..entry(label, profile) }
    }

    #[test]
    fn the_main_window_restores_its_own_or_the_adopted_survivors_placement() {
        let own = plan_restoration(
            vec![placed("window-a", "p2", "A"), placed("main", "p1", "M")],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        assert_eq!(own.main_placement.unwrap().home.monitor.name, "M");
        assert_eq!(own.additional[0].placement.as_ref().unwrap().home.monitor.name, "A");

        let adopted = plan_restoration(
            vec![placed("window-a", "p2", "A")],
            &ids(&["p1", "p2"]),
            "main",
            Some("p1"),
        );
        assert_eq!(adopted.main_placement.unwrap().home.monitor.name, "A");
    }

    #[test]
    fn closing_the_last_window_starts_over_but_keeps_its_placement() {
        let kept = placed("window-a", "p2", "DELL");
        let only = placement_only_entry("window-a", kept.placement.clone()).unwrap();
        assert!(only.profile_id.is_empty());
        let plan = plan_restoration(vec![only], &ids(&["p1", "p2"]), "main", Some("p1"));
        // Profiles start over: the main window shows the first Profile...
        assert_eq!(plan.main_profile_id.as_deref(), Some("p1"));
        assert!(plan.additional.is_empty());
        // ...where the last window was.
        assert_eq!(plan.main_placement.unwrap().home.monitor.name, "DELL");
        assert!(placement_only_entry("window-a", None).is_none());
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

    #[test]
    fn entries_without_placement_still_load_and_placement_round_trips() {
        let old = r#"[{"label":"main","profileId":"p1"}]"#;
        let entries: Vec<WindowEntry> = serde_json::from_str(old).unwrap();
        assert!(entries[0].placement.is_none());
        assert!(!serde_json::to_string(&entries).unwrap().contains("placement"));

        let json = r#"[{"label":"main","profileId":"p1","placement":{"home":{"monitor":{"name":"DELL","arrangementIndex":0},"relX":1.0,"relY":2.0,"width":3.0,"height":4.0}}}]"#;
        let entries: Vec<WindowEntry> = serde_json::from_str(json).unwrap();
        let back: Vec<WindowEntry> =
            serde_json::from_str(&serde_json::to_string(&entries).unwrap()).unwrap();
        assert_eq!(back[0].placement, entries[0].placement);
        assert_eq!(back[0].placement.as_ref().unwrap().home.monitor.name, "DELL");
    }

    const OLD: (f64, f64) = (840.0, 620.0);
    const NEW: (f64, f64) = (1000.0, 760.0);

    fn saved(width: u64, height: u64) -> String {
        serde_json::json!({
            "settings": {"width": width, "height": height, "x": 100, "y": 50, "maximized": false},
            "other": {"width": 1680, "height": 1240}
        })
        .to_string()
    }

    fn size_of(contents: &str, label: &str) -> (u64, u64) {
        let v: serde_json::Value = serde_json::from_str(contents).unwrap();
        (v[label]["width"].as_u64().unwrap(), v[label]["height"].as_u64().unwrap())
    }

    #[test]
    fn the_old_default_size_moves_to_the_new_one_at_its_scale() {
        let out = upgrade_old_default_size(&saved(1680, 1240), "settings", OLD, NEW).unwrap();
        assert_eq!(size_of(&out, "settings"), (2000, 1520));
        let out = upgrade_old_default_size(&saved(840, 620), "settings", OLD, NEW).unwrap();
        assert_eq!(size_of(&out, "settings"), (1000, 760));
        let out = upgrade_old_default_size(&saved(1050, 775), "settings", OLD, NEW).unwrap();
        assert_eq!(size_of(&out, "settings"), (1250, 950));
    }

    #[test]
    fn upgrading_keeps_the_position_and_other_windows() {
        let out = upgrade_old_default_size(&saved(1680, 1240), "settings", OLD, NEW).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!((v["settings"]["x"].as_i64(), v["settings"]["y"].as_i64()), (Some(100), Some(50)));
        assert_eq!(size_of(&out, "other"), (1680, 1240));
    }

    #[test]
    fn a_size_the_user_chose_is_kept() {
        assert_eq!(upgrade_old_default_size(&saved(1700, 1240), "settings", OLD, NEW), None);
        assert_eq!(upgrade_old_default_size(&saved(900, 700), "settings", OLD, NEW), None);
        // The old aspect, but at no scale a screen has (1.19): resized by hand.
        assert_eq!(upgrade_old_default_size(&saved(1000, 738), "settings", OLD, NEW), None);
        assert_eq!(upgrade_old_default_size(&saved(1400, 1033), "settings", OLD, NEW), None);
        // Already the new default: nothing to do, ever again.
        assert_eq!(upgrade_old_default_size(&saved(2000, 1520), "settings", OLD, NEW), None);
    }

    #[test]
    fn no_entry_or_a_broken_file_changes_nothing() {
        assert_eq!(upgrade_old_default_size(&saved(1680, 1240), "nope", OLD, NEW), None);
        assert_eq!(upgrade_old_default_size("not json", "settings", OLD, NEW), None);
    }

    #[test]
    fn a_remote_window_is_never_restored_as_a_local_one() {
        let remote = WindowEntry {
            label: "window-r".into(),
            // The server's default Profile has the local default's id.
            profile_id: "p1".into(),
            placement: None,
            remote: Some(crate::remote_windows::RemoteBinding {
                host_id: "h".into(),
                host_name: "box".into(),
                profile_id: "p1".into(),
                profile_name: "Default".into(),
            }),
        };
        let json = serde_json::to_string(&vec![remote.clone()]).unwrap();
        let back: Vec<WindowEntry> = serde_json::from_str(&json).unwrap();
        assert_eq!(back[0].remote, remote.remote);
        let plan = plan_restoration(vec![remote], &ids(&["p1"]), "main", Some("p1"));
        assert!(plan.additional.is_empty());
        assert_eq!(plan.main_adopted_label, None);
    }
}

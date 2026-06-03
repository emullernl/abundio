//! Multi-window orchestration. See ADR-0007.
//!
//! Each Abundio Window is a Tauri `WebviewWindow` with a stable label of the
//! form `window-<uuid>`. The `ActiveProfileState` map (in `profile_store`) is
//! the source of truth for which Profile each Window is showing.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::error::AbundioError;
use crate::profile_store::{ActiveProfileState, ProfileStore};

/// Window label used for the main (first) window. Stable across restarts so
/// `tauri-plugin-window-state` can save its geometry under a known key.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Singleton settings window label. The settings window is auxiliary —
/// doesn't claim a profile, isn't persisted in `windows.json`, doesn't count
/// toward "last window closing quits the app". See ADR-0007.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// True for any window that is a profile-bound Abundio window (vs. auxiliary
/// like Settings). Used to filter which windows are counted as "the last
/// window" for the quit-on-empty rule.
pub fn is_profile_window_label(label: &str) -> bool {
    label != SETTINGS_WINDOW_LABEL
}

/// Generates a fresh window label for spawn-on-demand windows. We deliberately
/// avoid recycling closed-window labels — the tauri-plugin-window-state file
/// is keyed by label and we want each new window to get its own geometry.
pub fn generate_window_label() -> String {
    format!("window-{}", uuid::Uuid::new_v4())
}

/// Body text for the quit confirmation shown when **Opened workspaces** would be
/// lost on quit. `window_count` lets us drop the awkward "across 1 window"
/// clause when everything is in a single Window. See ADR-0016. Pure so it can
/// be unit-tested without a dialog.
pub fn quit_confirm_message(total_opened: usize, window_count: usize) -> String {
    let ws = if total_opened == 1 {
        "workspace"
    } else {
        "workspaces"
    };
    if window_count <= 1 {
        format!(
            "You have {total_opened} opened {ws} with running agents and terminal processes. Quit Abundio?"
        )
    } else {
        format!(
            "You have {total_opened} opened {ws} across {window_count} windows with running agents and terminal processes. Quit Abundio?"
        )
    }
}

/// Opens the singleton settings window, or focuses it if already open. Pass
/// `initial_section` to deep-link to a specific settings section (e.g.
/// "profiles" for the "Manage Profiles…" menu item). When the window already
/// exists, the section is set by emitting `settings-set-section` to it.
pub fn open_or_focus_settings_window(
    app: &AppHandle<Wry>,
    initial_section: Option<&str>,
) -> Result<(), AbundioError> {
    use tauri::Emitter;

    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = existing.set_focus();
        if let Some(section) = initial_section {
            let _ = app.emit_to(
                SETTINGS_WINDOW_LABEL,
                "settings-set-section",
                section.to_string(),
            );
        }
        return Ok(());
    }

    // Encode the initial section in the URL so the settings window can read
    // it during its own startup (before any IPC roundtrip would resolve).
    let url_path = match initial_section {
        Some(section) => format!("index.html?settings&section={}", section),
        None => "index.html?settings".to_string(),
    };

    let mut builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(url_path.into()),
    )
    .title("Settings")
    .inner_size(840.0, 620.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder
        .build()
        .map_err(|e| AbundioError::InvalidOperation(format!("Settings window build failed: {}", e)))?;
    Ok(())
}

/// Renders a window title for a given profile name. Centralised so the Rust
/// spawn path and the frontend setTitle path use exactly the same format.
pub fn window_title_for(profile_name: &str) -> String {
    format!("Abundio - {} profile", profile_name)
}

/// Opens a new application Window showing the given Profile.
/// Atomically checks the ownership map: if the Profile is already shown in
/// another window, returns an `InvalidOperation` error.
///
/// New windows opened via the menu use `None` for `desired_label` and get a
/// fresh UUID. The `windows.json` restoration path passes `Some(persisted)`
/// so `tauri-plugin-window-state` can match the saved geometry — that plugin
/// keys its per-window-state file by label, so stable labels across launches
/// are what make size and position survive restart.
pub fn open_window_with_profile(
    app: &AppHandle<Wry>,
    profile_id: &str,
) -> Result<String, AbundioError> {
    open_window_with_profile_and_label(app, profile_id, None)
}

pub fn open_window_with_profile_and_label(
    app: &AppHandle<Wry>,
    profile_id: &str,
    desired_label: Option<&str>,
) -> Result<String, AbundioError> {
    let state = app
        .try_state::<ActiveProfileState>()
        .ok_or_else(|| AbundioError::InvalidOperation("ActiveProfileState missing".into()))?;

    // Refuse if the profile doesn't exist (avoids a window that immediately
    // can't load). Also captures the profile name for the window title.
    let profile_store = app
        .try_state::<ProfileStore>()
        .ok_or_else(|| AbundioError::InvalidOperation("ProfileStore missing".into()))?;
    let profile_name = profile_store
        .list()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.name);
    let Some(profile_name) = profile_name else {
        return Err(AbundioError::NotFound(format!(
            "Profile not found: {}",
            profile_id
        )));
    };

    // Use the requested label if provided and not currently in use; otherwise
    // mint a fresh one. The "in use" check here protects against the case
    // where a restoration tries to claim a label that's already been spawned
    // (e.g. the main window's "main" label).
    let label = match desired_label {
        Some(l) if !app.webview_windows().contains_key(l) => l.to_string(),
        _ => generate_window_label(),
    };

    // Atomically check-and-claim ownership BEFORE the window mounts (the
    // frontend reads it back via get_active_profile_for_window during startup).
    // try_claim folds the "already owned?" check and the insert under one lock
    // so two racing callers can't both build a window for the same profile.
    if let Some(existing_owner) = state.try_claim(&label, profile_id) {
        return Err(AbundioError::InvalidOperation(format!(
            "Profile is already open in window '{}'",
            existing_owner
        )));
    }

    // Match the main window's chrome on macOS: native title bar is overlaid
    // by transparent drag region, traffic lights float on top of content, no
    // OS-drawn title (the React Titlebar component renders it itself). The
    // tauri.macos.conf.json applies these settings to the conf-spawned main
    // window — we replicate them here for every additional window.
    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title(&window_title_for(&profile_name))
            .inner_size(1200.0, 800.0)
            .min_inner_size(600.0, 400.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let result = builder.build();

    match result {
        Ok(_window) => {
            // Tell other windows their menus need to refresh ("open elsewhere"
            // dimming for the now-owned profile).
            let _ = app.emit("profile-ownership-changed", ());
            crate::rebuild_menu_for_focused_window(app);
            Ok(label)
        }
        Err(e) => {
            // Roll back the ownership claim on build failure.
            state.remove_for_window(&label);
            Err(AbundioError::InvalidOperation(format!(
                "Window build failed: {}",
                e
            )))
        }
    }
}

/// Creates a new Profile auto-named "Untitled" (or "Untitled N" on collision)
/// and immediately opens it in a new Window.
pub fn create_untitled_profile_in_new_window(
    app: &AppHandle<Wry>,
) -> Result<String, AbundioError> {
    let store = app
        .try_state::<ProfileStore>()
        .ok_or_else(|| AbundioError::InvalidOperation("ProfileStore missing".into()))?;
    let existing = store.list()?;
    let name = next_untitled_name(&existing);

    let profile = store.create(&name)?;
    // Profile create implicitly broadcasts via the command path; here we
    // emit too so other windows see the new entry in their menus.
    let _ = app.emit("profiles-changed", ());

    open_window_with_profile(app, &profile.id)
}

/// Returns the next "Untitled" name not already in use. If no profile starts
/// with "Untitled", returns "Untitled". Otherwise returns "Untitled 2",
/// "Untitled 3", etc., picking the smallest N >= 2 that isn't taken.
pub fn next_untitled_name(existing: &[crate::profile_store::Profile]) -> String {
    let names: std::collections::HashSet<&str> =
        existing.iter().map(|p| p.name.as_str()).collect();
    if !names.contains("Untitled") {
        return "Untitled".to_string();
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("Untitled {}", n);
        if !names.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile_store::Profile;

    fn p(name: &str) -> Profile {
        Profile {
            id: name.to_string(),
            name: name.to_string(),
            position: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn untitled_when_none_exist() {
        assert_eq!(next_untitled_name(&[]), "Untitled");
    }

    #[test]
    fn untitled_increments_past_existing() {
        let list = vec![p("Untitled")];
        assert_eq!(next_untitled_name(&list), "Untitled 2");
    }

    #[test]
    fn untitled_picks_smallest_gap() {
        let list = vec![p("Untitled"), p("Untitled 2"), p("Untitled 4")];
        assert_eq!(next_untitled_name(&list), "Untitled 3");
    }

    #[test]
    fn untitled_ignores_unrelated_names() {
        let list = vec![p("Work"), p("Untitled"), p("Personal")];
        assert_eq!(next_untitled_name(&list), "Untitled 2");
    }

    #[test]
    fn quit_message_singular_single_window() {
        let msg = quit_confirm_message(1, 1);
        assert!(msg.contains("1 opened workspace "), "got: {msg}");
        assert!(!msg.contains("across"), "single window omits 'across': {msg}");
    }

    #[test]
    fn quit_message_plural_multi_window() {
        let msg = quit_confirm_message(5, 3);
        assert!(msg.contains("5 opened workspaces"), "got: {msg}");
        assert!(msg.contains("across 3 windows"), "got: {msg}");
    }
}

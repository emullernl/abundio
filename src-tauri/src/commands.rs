use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::error::AbundioError;
use crate::profile_store::{
    ActiveProfileState, BusyCounts, BusyCountsState, Profile, ProfileStore, ProfileUpdate,
};
use crate::workspace_store::{
    WorkspaceStore,
};

// ── PTY commands ──


/// Give this Window's channel for every PTY's output (raw bytes, framed by
/// `event_sink::frame_pty_output`). Replaces an earlier one from the same
/// Window (a reload).
#[tauri::command]
pub fn pty_output_subscribe(
    window: Window,
    channels: State<'_, std::sync::Arc<crate::tauri_sink::PtyChannels>>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) {
    channels.set(window.label(), channel);
}












// ── Menu ──

/// Sets the accelerator on the menu's Settings… item to the frontend's
/// **Open settings** Shortcut (`None` when Unbound), then rebuilds the menu.
/// Every Profile window pushes on start and on change; the menu signature
/// makes a repeat of the same value free.
#[tauri::command]
pub fn set_settings_accelerator(
    app: AppHandle,
    accelerator: Option<String>,
) -> Result<(), AbundioError> {
    if let Some(a) = &accelerator {
        if !crate::is_valid_accelerator(a) {
            return Err(AbundioError::InvalidOperation(format!(
                "invalid accelerator: {a:?}"
            )));
        }
    }
    if let Some(state) = app.try_state::<crate::SettingsAccelerator>() {
        if state.set(accelerator) {
            crate::rebuild_menu_for_focused_window(&app);
        }
    }
    Ok(())
}

// ── Profile commands ──

fn rebuild_menu_after_profile_change(app: &AppHandle) {
    crate::rebuild_menu_for_focused_window(app);
}

#[tauri::command]
pub async fn profile_list(store: State<'_, ProfileStore>) -> Result<Vec<Profile>, AbundioError> {
    store.list()
}

#[tauri::command]
pub async fn profile_create(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    name: String,
) -> Result<Profile, AbundioError> {
    let profile = store.create(&name)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(profile)
}

#[tauri::command]
pub async fn profile_update(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    id: String,
    updates: ProfileUpdate,
) -> Result<(), AbundioError> {
    store.update(&id, updates)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn profile_delete(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    workspaces: State<'_, WorkspaceStore>,
    active_state: State<'_, ActiveProfileState>,
    id: String,
) -> Result<(), AbundioError> {
    // The frontend confirm dialog warns the user when deletion will also
    // close a window. The "at least one profile must exist" rule is still
    // enforced inside ProfileStore::delete (returns InvalidOperation).
    //
    // If the profile is currently open in some window, destroy that window
    // first so it doesn't briefly continue rendering against rows that the
    // FK cascade is about to remove.
    if let Some(owner_label) = active_state.owner_of_profile(&id) {
        if let Some(owning_window) = app.get_webview_window(&owner_label) {
            let _ = owning_window.destroy();
        }
        active_state.remove_for_window(&owner_label);
    }

    // Read before the row goes: a default Orchestrator folder goes with its
    // Profile, one the user chose stays (ADR-0059). Only once the delete
    // itself is allowed.
    let orchestrator = workspaces
        .orchestrator_folder_of(&id)
        .ok()
        .flatten()
        // Never a folder another Workspace still points into.
        .filter(|f| {
            let rows = workspaces.all_folders().unwrap_or_default();
            !crate::workspace_folders::holds_work(&rows, std::path::Path::new(f))
        });
    store.delete(&id)?;
    if let Some(folder) = orchestrator {
        crate::orchestrator::forget_folder_at(
            &crate::app_paths::shared_root(),
            std::path::Path::new(&folder),
        );
    }
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    let _ = app.emit("profile-ownership-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn profile_reorder(
    app: AppHandle,
    store: State<'_, ProfileStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder(&ids)?;
    rebuild_menu_after_profile_change(&app);
    let _ = app.emit("profiles-changed", ());
    Ok(())
}

/// Called by the frontend whenever the active profile for the calling window
/// changes (in-window switch, or on initial load to sync the map). Updates the
/// per-window ownership map, rebuilds the native menu, and broadcasts a
/// `profile-ownership-changed` event so other Windows can refresh their UI.
///
/// Errors when another Window already owns the profile, so the "one Profile,
/// at most one Window" rule holds even if two Windows try the same switch.
///
/// Rejects calls from auxiliary windows (e.g. settings) — those never own a
/// profile by definition (ADR-0007), and accepting their writes would pollute
/// the ownership map. The frontend bypasses this command in those windows,
/// but the backend rejects defensively so a future bug can't silently
/// register a stale entry that survives in windows.json across restarts.
#[tauri::command]
pub async fn set_active_profile_id(
    app: AppHandle,
    window: Window,
    state: State<'_, ActiveProfileState>,
    profile_id: Option<String>,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if !crate::window_management::is_profile_window_label(&label) {
        return Ok(());
    }
    state.claim_for_window(&label, profile_id.as_deref())?;
    crate::rebuild_menu_for_focused_window(&app);
    let _ = app.emit("profile-ownership-changed", ());
    Ok(())
}

/// Frontend startup call: returns the profile id this Window was spawned with
/// (or None if the map is missing this window, in which case the frontend
/// should fall back to its persisted/first-profile logic and report back).
#[tauri::command]
pub async fn get_active_profile_for_window(
    window: Window,
    state: State<'_, ActiveProfileState>,
) -> Result<Option<String>, AbundioError> {
    Ok(state.get_for_window(window.label()))
}

/// The frontend pushes its Window's **busy tally** whenever the tuple changes,
/// so Rust can sum across all Windows at quit time and decide whether to
/// confirm — and what the confirmation should say (see ADR-0034). Auxiliary
/// windows (settings) never own workspaces and are ignored defensively,
/// mirroring `set_active_profile_id`.
#[tauri::command]
pub async fn report_busy_counts(
    window: Window,
    state: State<'_, BusyCountsState>,
    counts: BusyCounts,
) -> Result<(), AbundioError> {
    let label = window.label().to_string();
    if !crate::window_management::is_profile_window_label(&label) {
        return Ok(());
    }
    state.set_for_window(&label, counts);
    Ok(())
}

/// Returns the full profileId → windowLabel ownership map. The frontend uses
/// this to render "Open in another window" disabled-states in the Settings UI.
#[tauri::command]
pub async fn get_profile_ownership_map(
    state: State<'_, ActiveProfileState>,
) -> Result<std::collections::HashMap<String, String>, AbundioError> {
    // We invert the (label → profileId) map for the frontend: it wants
    // profileId → label so it can look up "who owns profile X?" cheaply.
    let snapshot = state.snapshot();
    let inverted: std::collections::HashMap<String, String> = snapshot
        .into_iter()
        .map(|(label, profile_id)| (profile_id, label))
        .collect();
    Ok(inverted)
}

#[tauri::command]
pub async fn open_window_with_profile(
    app: AppHandle,
    profile_id: String,
) -> Result<String, AbundioError> {
    crate::window_management::open_window_with_profile(&app, &profile_id)
}

#[tauri::command]
pub async fn open_settings_window(
    app: AppHandle,
    section: Option<String>,
    check_host: Option<String>,
) -> Result<(), AbundioError> {
    match check_host {
        Some(host) => crate::window_management::open_settings_to_check_host(&app, &host),
        None => crate::window_management::open_or_focus_settings_window(&app, section.as_deref()),
    }
}

/// Focus the window identified by `label`. Used by the frontend's
/// `requestSwitchProfile` path when the target profile is already open in
/// another window — see ADR-0007 follow-up.
#[tauri::command]
pub async fn focus_window(app: AppHandle, label: String) -> Result<(), AbundioError> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| {
            AbundioError::InvalidOperation(format!("focus failed: {}", e))
        })?;
        Ok(())
    } else {
        Err(AbundioError::NotFound(format!("Window not found: {}", label)))
    }
}

#[tauri::command]
pub async fn create_untitled_profile_in_new_window(
    app: AppHandle,
) -> Result<String, AbundioError> {
    crate::window_management::create_untitled_profile_in_new_window(&app)
}

// ── Workspace commands ──










// ── Tab commands ──









// ── Note commands ──



// ── Agent telemetry commands ──
//
// The frontend Turn tracker records one row per Turn at finalize; the
// Statistics overlay queries Profile-scoped rollups. See
// docs/plans/agent-turn-telemetry-and-statistics-overlay.md and ADR-0018.





// ── PTY log commands ──






// ── File watcher commands ──



// ── Worktree live-sync watcher ──


// ── Git scheduler commands ──
//
// Per-workspace Rust-initiated git refresh. The frontend calls `start` on
// workspace open and `stop` on close; in between, the scheduler emits
// `git-state-<workspaceId>` events whenever the file watcher detects
// meaningful change. This replaces the JS-side `fetchChanges`-on-every-event
// pattern that froze the main thread during `git stash` (see git_scheduler.rs).



// ── Font commands ──

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, AbundioError> {
    let families = tauri::async_runtime::spawn_blocking(|| {
        font_kit::source::SystemSource::new()
            .all_families()
            .map_err(|e| AbundioError::Font(e.to_string()))
    })
    .await
    .map_err(|e| AbundioError::Font(e.to_string()))??;
    Ok(families)
}

// ── Agent hooks ──





/// Show a file in the desktop's file manager: always this computer's
/// (a remote Workspace hides it).
#[tauri::command]
pub async fn fs_reveal_in_folder(path: String) -> Result<(), AbundioError> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        std::process::Command::new("xdg-open").arg(&parent).spawn()?;
    }
    Ok(())
}

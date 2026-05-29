use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::error::AbundioError;
use crate::file_watcher::FileWatcher;
use crate::git_scheduler::GitScheduler;
use crate::profile_store::{ActiveProfileState, Profile, ProfileStore, ProfileUpdate};
use crate::pty_manager::PtyManager;
use crate::workspace_store::{WorkspaceStore, WorkspaceUpdate, WorkspaceWithTabs, Tab, TabUpdate};
use crate::shell_env;

// ── PTY commands ──

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    pty_mgr: State<'_, PtyManager>,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    shell: Option<String>,
    log_id: Option<String>,
    pty_id: Option<String>,
    workspace_name: Option<String>,
    window_label: Option<String>,
) -> Result<String, AbundioError> {
    pty_mgr.spawn(
        app,
        &cwd,
        command.as_deref(),
        shell.as_deref(),
        cols,
        rows,
        log_id.as_deref(),
        pty_id.as_deref(),
        workspace_name.as_deref(),
        window_label.as_deref(),
    )
}

#[tauri::command]
pub async fn list_available_shells() -> Result<Vec<shell_env::AvailableShell>, AbundioError> {
    Ok(shell_env::list_available_shells())
}

#[tauri::command]
pub async fn pty_write(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
    data: String,
) -> Result<(), AbundioError> {
    // data comes as a UTF-8 string from xterm.js onData
    pty_mgr.write(&pty_id, data.into_bytes())
}

#[tauri::command]
pub async fn pty_resize(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AbundioError> {
    pty_mgr.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(
    pty_mgr: State<'_, PtyManager>,
    pty_id: String,
) -> Result<(), AbundioError> {
    pty_mgr.kill(&pty_id)
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

    store.delete(&id)?;
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
    match profile_id {
        Some(ref id) => {
            state.set_for_window(&label, id);
        }
        None => {
            state.remove_for_window(&label);
        }
    }
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
) -> Result<(), AbundioError> {
    crate::window_management::open_or_focus_settings_window(&app, section.as_deref())
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

#[tauri::command]
pub async fn workspace_create(
    store: State<'_, WorkspaceStore>,
    name: String,
    root_folder: String,
    profile_id: String,
) -> Result<WorkspaceWithTabs, AbundioError> {
    store.create(&name, &root_folder, &profile_id)
}

#[tauri::command]
pub async fn workspace_list(
    store: State<'_, WorkspaceStore>,
    profile_id: String,
) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
    store.list(&profile_id)
}

#[tauri::command]
pub async fn workspace_update(
    store: State<'_, WorkspaceStore>,
    id: String,
    updates: WorkspaceUpdate,
) -> Result<(), AbundioError> {
    store.update(&id, updates)
}

#[tauri::command]
pub async fn workspace_delete(
    store: State<'_, WorkspaceStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete(&id)
}

#[tauri::command]
pub async fn workspace_reorder(
    store: State<'_, WorkspaceStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder_workspaces(&ids)
}

// ── Tab commands ──

#[tauri::command]
pub async fn tab_create(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    name: String,
) -> Result<Tab, AbundioError> {
    store.create_tab(&workspace_id, &name)
}

#[tauri::command]
pub async fn tab_list(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
) -> Result<Vec<Tab>, AbundioError> {
    store.list_tabs(&workspace_id)
}

#[tauri::command]
pub async fn tab_update(
    store: State<'_, WorkspaceStore>,
    id: String,
    updates: TabUpdate,
) -> Result<(), AbundioError> {
    store.update_tab(&id, updates)
}

#[tauri::command]
pub async fn tab_delete(
    store: State<'_, WorkspaceStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete_tab(&id)
}

// ── Note commands ──

#[tauri::command]
pub async fn note_get(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
) -> Result<String, AbundioError> {
    store.get_note(&workspace_id)
}

#[tauri::command]
pub async fn note_set(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    content: String,
) -> Result<(), AbundioError> {
    store.set_note(&workspace_id, &content)
}

// ── PTY log commands ──

#[tauri::command]
pub async fn pty_read_log(log_id: String) -> Result<Option<String>, AbundioError> {
    PtyManager::read_log(&log_id)
}

#[tauri::command]
pub async fn pty_write_snapshot(pane_id: String, data: String) -> Result<(), AbundioError> {
    PtyManager::write_snapshot(&pane_id, &data)
}

#[tauri::command]
pub async fn pty_read_snapshot(pane_id: String) -> Result<Option<String>, AbundioError> {
    PtyManager::read_snapshot(&pane_id)
}

#[tauri::command]
pub async fn pty_delete_log(log_id: String) -> Result<(), AbundioError> {
    PtyManager::delete_log(&log_id)
}

#[tauri::command]
pub async fn pty_cleanup_stale_logs(pane_ids: Vec<String>) -> Result<(), AbundioError> {
    PtyManager::cleanup_stale_logs(&pane_ids)
}

// ── File watcher commands ──

#[tauri::command]
pub async fn fs_watch_start(
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
    root_path: String,
) -> Result<(), AbundioError> {
    watcher.start_watching(app, &root_path)
}

#[tauri::command]
pub async fn fs_watch_stop(
    watcher: State<'_, FileWatcher>,
    root_path: String,
) -> Result<(), AbundioError> {
    watcher.stop_watching(&root_path);
    Ok(())
}

// ── Git scheduler commands ──
//
// Per-workspace Rust-initiated git refresh. The frontend calls `start` on
// workspace open and `stop` on close; in between, the scheduler emits
// `git-state-<workspaceId>` events whenever the file watcher detects
// meaningful change. This replaces the JS-side `fetchChanges`-on-every-event
// pattern that froze the main thread during `git stash` (see git_scheduler.rs).

#[tauri::command]
pub async fn git_scheduler_start(
    app: AppHandle,
    scheduler: State<'_, GitScheduler>,
    workspace_id: String,
    root_path: String,
    base_branch: Option<String>,
) -> Result<(), AbundioError> {
    scheduler.start(app, workspace_id, root_path, base_branch);
    Ok(())
}

#[tauri::command]
pub async fn git_scheduler_stop(
    scheduler: State<'_, GitScheduler>,
    workspace_id: String,
) -> Result<(), AbundioError> {
    scheduler.stop(&workspace_id);
    Ok(())
}

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

/// Enable or disable Agent status hooks by (un)provisioning hook configs in
/// each installed Agent's global config directory.
#[tauri::command]
pub async fn agent_hooks_provision(enabled: bool) -> Result<(), AbundioError> {
    tauri::async_runtime::spawn_blocking(move || crate::agent_hooks::provision(enabled))
        .await
        .map_err(|e| AbundioError::Io(std::io::Error::other(e.to_string())))?
}

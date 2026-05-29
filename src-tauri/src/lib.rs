pub mod agent_hooks;
pub mod agent_registry;
pub mod app_metrics;
pub mod commands;
pub mod config;
pub mod dev_environments;
pub mod error;
pub mod events;
pub mod file_explorer;
pub mod file_watcher;
pub mod gh_commands;
pub mod git_commands;
pub mod git_libgit2;
pub mod git_scheduler;
pub mod hook_server;
pub mod migrations;
pub mod process_monitor;
pub mod profile_store;
pub mod pty_manager;
pub mod search;
pub mod window_management;
pub mod window_persistence;
pub mod workspace_store;
pub mod shell_env;

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use profile_store::ProfileStore;
use pty_manager::PtyManager;
use workspace_store::WorkspaceStore;

/// Builds the application menu for the currently focused Window. Reads the
/// per-window profile ownership map from `ActiveProfileState` and the profile
/// list from `ProfileStore` (managed state). The "Switch Profile" submenu's
/// checkmark reflects the *focused* Window's active Profile; the "New Window
/// with Profile" submenu dims entries whose profile is owned by a non-focused
/// Window.
pub fn build_menu(
    handle: &AppHandle<Wry>,
    focused_window_label: Option<&str>,
) -> tauri::Result<Menu<Wry>> {
    let pkg = handle.package_info();

    // Snapshot ownership and active-profile-for-focused-window once so the
    // menu is internally consistent.
    let (ownership_snapshot, active_profile_id) = match handle.try_state::<ProfileStore>() {
        Some(_) => match handle.try_state::<profile_store::ActiveProfileState>() {
            Some(state) => {
                let snap = state.snapshot();
                let active = focused_window_label.and_then(|l| snap.get(l).cloned());
                (snap, active)
            }
            None => (Default::default(), None),
        },
        None => (Default::default(), None),
    };

    let about_metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let settings_item =
        MenuItem::with_id(handle, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;

    // Custom Quit item (replaces PredefinedMenuItem::quit) so we can intercept
    // Cmd+Q BEFORE Tauri's destroy storm starts. The predefined quit goes
    // straight to [NSApp terminate:], which destroys windows before any of
    // our Rust handlers can snapshot windows.json. Our custom item routes
    // through on_menu_event, where we save the snapshot, set QuittingFlag,
    // and only then call app.exit(0). See ADR-0007.
    let quit_item =
        MenuItem::with_id(handle, "quit-app", "Quit Abundio", true, Some("CmdOrCtrl+Q"))?;

    // Profile-related submenus. "New Window with Profile" lists every profile
    // (dimmed if owned by another window) plus a "New Untitled Profile…"
    // footer. "Switch Profile" is the in-window switch with the checkmark
    // reflecting the focused window's active profile.
    let new_window_with_profile_submenu = build_new_window_with_profile_submenu(
        handle,
        &ownership_snapshot,
        focused_window_label,
    )?;
    let switch_profile_submenu =
        build_switch_profile_submenu(handle, active_profile_id.as_deref())?;

    // macOS app submenu (Abundio menu)
    #[cfg(target_os = "macos")]
    let app_submenu = Submenu::with_items(
        handle,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about_metadata.clone()))?,
            &PredefinedMenuItem::separator(handle)?,
            &settings_item,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit_item,
        ],
    )?;

    // File menu — "New Window with Profile" is first (additive), "Switch
    // Profile" is second (in-window swap, lossy). See ADR-0007.
    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &new_window_with_profile_submenu,
            &switch_profile_submenu,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &settings_item,
            &PredefinedMenuItem::separator(handle)?,
            &new_window_with_profile_submenu,
            &switch_profile_submenu,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
            &quit_item,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    #[cfg(not(target_os = "macos"))]
    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[&PredefinedMenuItem::about(handle, None, Some(about_metadata))?],
    )?;

    Menu::with_items(
        handle,
        &[
            #[cfg(target_os = "macos")]
            &app_submenu,
            &file_menu,
            &edit_menu,
            #[cfg(target_os = "macos")]
            &view_menu,
            &window_menu,
            #[cfg(not(target_os = "macos"))]
            &help_menu,
        ],
    )
}

/// Builds the "Switch Profile" submenu: one CheckMenuItem per profile (the
/// focused window's active profile is checked), separator, "Manage Profiles…".
/// Menu item IDs use the `switch-profile:<uuid>` convention.
fn build_switch_profile_submenu(
    handle: &AppHandle<Wry>,
    active_profile_id: Option<&str>,
) -> tauri::Result<Submenu<Wry>> {
    let profiles = handle
        .try_state::<ProfileStore>()
        .and_then(|s| s.list().ok())
        .unwrap_or_default();

    let mut items: Vec<CheckMenuItem<Wry>> = Vec::with_capacity(profiles.len());
    for profile in &profiles {
        let id = format!("switch-profile:{}", profile.id);
        let checked = active_profile_id.map(|a| a == profile.id).unwrap_or(false);
        items.push(CheckMenuItem::with_id(
            handle, &id, &profile.name, true, checked, None::<&str>,
        )?);
    }

    let separator = PredefinedMenuItem::separator(handle)?;
    let manage_item = MenuItem::with_id(
        handle,
        "manage-profiles",
        "Manage Profiles...",
        true,
        None::<&str>,
    )?;

    let mut refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = Vec::new();
    for item in &items {
        refs.push(item);
    }
    refs.push(&separator);
    refs.push(&manage_item);

    Submenu::with_items(handle, "Switch Profile", true, &refs)
}

/// Builds the "New Window with Profile" submenu: one MenuItem per profile,
/// disabled when the profile is owned by a Window other than the focused one
/// (and also when it is owned by the focused window — opening "in a new
/// window" would just duplicate the current view). Separator, then "New
/// Untitled Profile…" footer. Menu item IDs:
///   - `open-profile-in-new-window:<uuid>`
///   - `new-untitled-profile-window`
fn build_new_window_with_profile_submenu(
    handle: &AppHandle<Wry>,
    ownership: &std::collections::HashMap<String, String>,
    focused_window_label: Option<&str>,
) -> tauri::Result<Submenu<Wry>> {
    let profiles = handle
        .try_state::<ProfileStore>()
        .and_then(|s| s.list().ok())
        .unwrap_or_default();

    let mut items: Vec<MenuItem<Wry>> = Vec::with_capacity(profiles.len());
    for profile in &profiles {
        let id = format!("open-profile-in-new-window:{}", profile.id);
        // Find the window (if any) currently showing this profile.
        let owner: Option<&String> = ownership
            .iter()
            .find_map(|(label, pid)| (pid == &profile.id).then_some(label));
        let is_owned = owner.is_some();
        // Show "(open)" annotation when this profile is in use anywhere.
        let label = if is_owned {
            // If the focused window itself owns it, suffix with "(this window)";
            // otherwise the generic "(open elsewhere)".
            let self_owns = focused_window_label
                .zip(owner)
                .is_some_and(|(focused, owner)| focused == owner);
            if self_owns {
                format!("{} (this window)", profile.name)
            } else {
                format!("{} (open elsewhere)", profile.name)
            }
        } else {
            profile.name.clone()
        };
        items.push(MenuItem::with_id(
            handle,
            &id,
            &label,
            !is_owned,
            None::<&str>,
        )?);
    }

    let separator = PredefinedMenuItem::separator(handle)?;
    let untitled_item = MenuItem::with_id(
        handle,
        "new-untitled-profile-window",
        "New Untitled Profile...",
        true,
        None::<&str>,
    )?;

    let mut refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = Vec::new();
    for item in &items {
        refs.push(item);
    }
    refs.push(&separator);
    refs.push(&untitled_item);

    Submenu::with_items(handle, "New Window with Profile", true, &refs)
}

/// Returns true when no *profile-bound* windows remain (the settings window
/// alone doesn't count). Used by the quit-on-last-window logic so closing
/// every profile window quits the app even if the settings window is open.
fn no_profile_windows_open(app: &AppHandle<Wry>) -> bool {
    app.webview_windows()
        .keys()
        .all(|label| !window_management::is_profile_window_label(label))
}

/// Emits an event to the currently-focused webview only. Used for "open
/// settings" / "switch profile" intents from the native menu — those are
/// always per-window and shouldn't fan out to other Windows.
pub fn emit_to_focused<S: serde::Serialize + Clone>(
    app: &AppHandle<Wry>,
    event: &str,
    payload: &S,
) -> tauri::Result<()> {
    for (label, w) in app.webview_windows() {
        if w.is_focused().unwrap_or(false) {
            return app.emit_to(label.as_str(), event, payload.clone());
        }
    }
    // Fallback: no window reported focused (rare, e.g. during a focus
    // transition) — broadcast so the action isn't lost.
    app.emit(event, payload.clone())
}

/// Rebuilds the application menu, sourcing the focused-window label from the
/// app's currently-focused webview. Called after any change that could affect
/// menu rendering: profile CRUD, in-window profile switch, window focus
/// change, window open/close.
pub fn rebuild_menu_for_focused_window(app: &AppHandle<Wry>) {
    let focused_label = app
        .webview_windows()
        .iter()
        .find_map(|(label, w)| w.is_focused().unwrap_or(false).then(|| label.clone()))
        // Fall back to the first window if none reports focused — happens on
        // startup before the OS has assigned focus, and during rapid
        // open/close events.
        .or_else(|| app.webview_windows().keys().next().cloned());
    match build_menu(app, focused_label.as_deref()) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                eprintln!("[abundio] failed to set menu: {e}");
            }
        }
        Err(e) => eprintln!("[abundio] failed to build menu: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            // Initialize SQLite + run migrations. Two connections so the
            // ProfileStore and WorkspaceStore can be locked independently;
            // SQLite WAL mode (set in open_db) handles concurrent access.
            let conn = migrations::open_db().expect("Failed to open database");
            let store = WorkspaceStore::new(conn);
            app.manage(store);

            let profile_conn = migrations::open_db().expect("Failed to open database");
            let profile_store = ProfileStore::new(profile_conn);
            app.manage(profile_store);

            // Active profile cache (set by the frontend after rehydrating its
            // settings store). Used by the menu rebuild.
            app.manage(profile_store::ActiveProfileState::default());
            // Flag flipped on by `RunEvent::ExitRequested` so per-window
            // Destroyed events know to skip their save-to-windows.json logic
            // — the quit handler captured the full pre-quit state once.
            app.manage(profile_store::QuittingFlag::default());

            // Build and set the application menu. At this point no window is
            // focused yet (we're still in setup), so the menu falls back to
            // building against the first window once one exists; the focus
            // listener below triggers a rebuild as soon as one comes online.
            let menu = build_menu(&app.handle(), None)?;
            app.set_menu(menu)?;

            // Initialize PTY manager
            let pty_mgr = PtyManager::new();
            app.manage(pty_mgr);

            // Initialize file watcher
            app.manage(file_watcher::FileWatcher::new());
            app.manage(git_scheduler::GitScheduler::new());

            // Initialize search manager
            app.manage(search::SearchManager::new());

            // Start the resource-usage sampler. Pushes `app-metrics` events
            // (whole-tree CPU + memory) to the status bar on a background
            // thread; see app_metrics.rs for why this is a push, not an invoke.
            app_metrics::start_metrics_sampler(app.handle().clone());

            // Initialize the agent hook server (loopback HTTP receiver for
            // Agent lifecycle hooks). Non-fatal if it fails to bind.
            match hook_server::HookServer::start(app.handle().clone()) {
                Ok(server) => {
                    app.manage(server);
                }
                Err(e) => {
                    eprintln!("[abundio] agent hook server failed to start: {e}");
                }
            }

            // Always refresh the relay scripts on disk so they match this
            // binary's RELAY_SH/RELAY_PS1. Independent of the user's
            // hooks-enabled setting — those scripts are inert no-ops outside
            // an Abundio-spawned PTY. The frontend's rehydrate path still
            // owns provisioning hook entries into user agent configs.
            if let Err(e) = agent_hooks::refresh_relay_scripts() {
                eprintln!("[abundio] relay script refresh failed: {e}");
            }

            // Restore windows from windows.json. The tauri.conf-spawned main
            // window is already mounting; we seed its profile from the
            // persisted entry if present (else first profile in position
            // order). Then spawn additional windows for any further entries.
            //
            // Invariant: a Profile cannot be owned by two windows at once. We
            // dedupe entries by profile id, keeping the first occurrence.
            let active_state = app.state::<profile_store::ActiveProfileState>();
            let ps = app.state::<ProfileStore>();
            let all_profiles = ps.list().unwrap_or_default();
            let valid_ids: std::collections::HashSet<&str> =
                all_profiles.iter().map(|p| p.id.as_str()).collect();

            let persisted = window_persistence::load();
            let mut claimed_profiles: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            let main_label = window_management::MAIN_WINDOW_LABEL;
            // Find the persisted main-window entry (if any) and seed it.
            let main_profile_id = persisted
                .iter()
                .find(|e| e.label == main_label && valid_ids.contains(e.profile_id.as_str()))
                .map(|e| e.profile_id.clone())
                .or_else(|| all_profiles.first().map(|p| p.id.clone()));
            if let Some(pid) = main_profile_id {
                active_state.set_for_window(main_label, &pid);
                claimed_profiles.insert(pid.clone());
                // Override the tauri.conf static title with the profile-aware
                // title. The frontend will re-set it on profile change.
                if let Some(name) = all_profiles
                    .iter()
                    .find(|p| p.id == pid)
                    .map(|p| p.name.clone())
                {
                    if let Some(main_window) = app.get_webview_window(main_label) {
                        let _ = main_window.set_title(
                            &window_management::window_title_for(&name),
                        );
                    }
                }
            }

            // Spawn additional windows from the remaining persisted entries.
            // Defer spawning until after setup() returns so the main window is
            // fully initialised; otherwise the second window can race and end
            // up without its assets fully wired.
            let app_handle = app.handle().clone();
            let additional: Vec<window_persistence::WindowEntry> = persisted
                .into_iter()
                .filter(|e| {
                    // Defensive: skip non-profile labels (e.g. a stale
                    // "settings" entry written by a pre-fix build) so they
                    // never get respawned as profile windows on launch.
                    window_management::is_profile_window_label(&e.label)
                        && e.label != main_label
                        && valid_ids.contains(e.profile_id.as_str())
                })
                .filter(|e| {
                    if claimed_profiles.contains(&e.profile_id) {
                        false
                    } else {
                        claimed_profiles.insert(e.profile_id.clone());
                        true
                    }
                })
                .collect();
            if !additional.is_empty() {
                tauri::async_runtime::spawn(async move {
                    for entry in additional {
                        // Reuse the persisted label so tauri-plugin-window-state
                        // can match the saved geometry — its per-window state
                        // file is keyed by label, so a fresh UUID per launch
                        // would reset position/size to defaults.
                        if let Err(e) =
                            window_management::open_window_with_profile_and_label(
                                &app_handle,
                                &entry.profile_id,
                                Some(&entry.label),
                            )
                        {
                            eprintln!(
                                "[abundio] failed to restore window for profile {}: {}",
                                entry.profile_id, e
                            );
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                rebuild_menu_for_focused_window(&window.app_handle().clone());
            }
            tauri::WindowEvent::Destroyed => {
                let app_handle = window.app_handle().clone();
                let label = window.label().to_string();

                // The settings window is auxiliary — never claims a profile,
                // not persisted in windows.json, and doesn't count toward
                // "last window closing quits the app". Treat its destroy as
                // a no-op for all that bookkeeping.
                if !window_management::is_profile_window_label(&label) {
                    return;
                }

                // Are we in the middle of an app-level quit? If so, the
                // RunEvent::ExitRequested handler already saved the full
                // pre-quit snapshot; per-window destroys must NOT save (each
                // intermediate save would shrink the persisted set and lose
                // the windows that destroy later).
                let is_quitting = app_handle
                    .try_state::<profile_store::QuittingFlag>()
                    .map(|f| *f.0.lock().unwrap())
                    .unwrap_or(false);

                if let Some(state) =
                    app_handle.try_state::<profile_store::ActiveProfileState>()
                {
                    state.remove_for_window(&label);
                }
                let _ = app_handle.emit("profile-ownership-changed", ());
                rebuild_menu_for_focused_window(&app_handle);

                if is_quitting {
                    // Quit-driven close — skip all saving (already done).
                    // Still need to call exit when the last window is gone,
                    // in case Tauri's quit was triggered by our own code.
                    if no_profile_windows_open(&app_handle) {
                        app_handle.exit(0);
                    }
                    return;
                }

                // User-initiated close of a single window (the other windows
                // remain open). Save the post-removal state so this window
                // disappears from the next launch's restoration. Both the
                // last-window and windows-remain paths persist the same
                // snapshot — only the last-window case additionally exits — so
                // do the save once up front.
                if let Some(state) =
                    app_handle.try_state::<profile_store::ActiveProfileState>()
                {
                    let remaining = window_persistence::snapshot_from_state(&state);
                    if let Err(e) = window_persistence::save(&remaining) {
                        eprintln!("[abundio] failed to persist windows.json: {e}");
                    }
                }
                if no_profile_windows_open(&app_handle) {
                    // Last window closed by user — equivalent to "quit". The
                    // snapshot just saved EXCLUDES this window (it's been
                    // explicitly closed, so the user wants it gone next run);
                    // it's empty, meaning next launch starts fresh with just
                    // the main window on first profile. That's the right
                    // semantics — if the user has intentionally closed every
                    // window, they're saying "start over."
                    app_handle.exit(0);
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "quit-app" {
                // Custom Quit handler — must run BEFORE Tauri starts
                // destroying windows so we can snapshot windows.json with the
                // full pre-quit set. Tauri 2 fires RunEvent::ExitRequested
                // only after the LAST window destroys (see ADR-0007 / source
                // of tauri-runtime-wry::lib.rs), so we can't rely on it for
                // the menu-driven quit path.
                if let Some(flag) = app.try_state::<profile_store::QuittingFlag>() {
                    *flag.0.lock().unwrap() = true;
                }
                if let Some(state) =
                    app.try_state::<profile_store::ActiveProfileState>()
                {
                    let snapshot = window_persistence::snapshot_from_state(&state);
                    if let Err(e) = window_persistence::save(&snapshot) {
                        eprintln!("[abundio] failed to persist windows.json at quit: {e}");
                    }
                }
                app.exit(0);
                return;
            }
            if id == "settings" {
                // Settings is a singleton global window — see ADR-0007 / the
                // window_management::open_or_focus_settings_window comment.
                if let Err(e) =
                    window_management::open_or_focus_settings_window(app, None)
                {
                    eprintln!("[abundio] failed to open settings window: {e}");
                }
            } else if id == "manage-profiles" {
                if let Err(e) =
                    window_management::open_or_focus_settings_window(app, Some("profiles"))
                {
                    eprintln!("[abundio] failed to open settings window: {e}");
                }
            } else if id == "new-untitled-profile-window" {
                // Spawn a new window with a freshly-created Untitled profile.
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) =
                        window_management::create_untitled_profile_in_new_window(&handle)
                    {
                        eprintln!("[abundio] failed to open untitled profile window: {e}");
                    }
                });
            } else if let Some(profile_id) = id.strip_prefix("switch-profile:") {
                // Three cases, in priority order:
                //   1. Profile is open in THIS focused window → no-op (already
                //      showing it; the menu has it checked).
                //   2. Profile is open in ANOTHER window → focus that window
                //      instead of switching here.
                //   3. Profile is unowned → emit the existing switch event so
                //      the frontend's close-opened-workspaces confirm dialog
                //      runs and then swaps this window's profile.
                let focused_label = app
                    .webview_windows()
                    .iter()
                    .find_map(|(label, w)| {
                        w.is_focused().unwrap_or(false).then(|| label.clone())
                    });
                let owner_label = app
                    .try_state::<profile_store::ActiveProfileState>()
                    .and_then(|s| s.owner_of_profile(profile_id));
                match (owner_label, focused_label.as_deref()) {
                    (Some(owner), Some(focused)) if owner == focused => {
                        // Case 1: already active here — nothing to do.
                    }
                    (Some(owner), _) => {
                        // Case 2: another window owns it; focus that window.
                        if let Some(window) = app.get_webview_window(&owner) {
                            let _ = window.set_focus();
                        }
                    }
                    (None, _) => {
                        // Case 3: profile is unowned; do the in-window switch.
                        let _ = emit_to_focused(
                            app,
                            "switch-profile-request",
                            &profile_id.to_string(),
                        );
                    }
                }
            } else if let Some(profile_id) = id.strip_prefix("open-profile-in-new-window:") {
                let handle = app.clone();
                let pid = profile_id.to_string();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = window_management::open_window_with_profile(&handle, &pid) {
                        eprintln!("[abundio] failed to open window with profile: {e}");
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::profile_list,
            commands::profile_create,
            commands::profile_update,
            commands::profile_delete,
            commands::profile_reorder,
            commands::set_active_profile_id,
            commands::get_active_profile_for_window,
            commands::get_profile_ownership_map,
            commands::open_window_with_profile,
            commands::create_untitled_profile_in_new_window,
            commands::open_settings_window,
            commands::focus_window,
            commands::workspace_create,
            commands::workspace_list,
            commands::workspace_update,
            commands::workspace_delete,
            commands::workspace_reorder,
            commands::pty_read_log,
            commands::pty_write_snapshot,
            commands::pty_read_snapshot,
            commands::pty_delete_log,
            commands::pty_cleanup_stale_logs,
            commands::tab_create,
            commands::tab_list,
            commands::tab_update,
            commands::tab_delete,
            commands::note_get,
            commands::note_set,
            file_explorer::fs_list_dir,
            file_explorer::fs_list_files,
            file_explorer::fs_index_workspace_files,
            file_explorer::fs_read_file,
            file_explorer::fs_write_file,
            file_explorer::fs_file_exists,
            file_explorer::fs_create_file,
            file_explorer::fs_create_folder,
            file_explorer::fs_rename,
            file_explorer::fs_delete,
            file_explorer::fs_reveal_in_folder,
            commands::fs_watch_start,
            commands::fs_watch_stop,
            commands::git_scheduler_start,
            commands::git_scheduler_stop,
            git_commands::git_changed_files,
            git_commands::git_fetch_bundle,
            git_commands::git_file_diff,
            git_commands::git_branch_info,
            git_commands::git_list_branches,
            git_commands::git_status_fingerprint,
            git_commands::git_workspaces_summary,
            gh_commands::gh_status,
            gh_commands::gh_review_requests,
            gh_commands::gh_review_requests_all,
            gh_commands::gh_my_prs,
            gh_commands::gh_my_prs_all,
            commands::list_system_fonts,
            commands::list_available_shells,
            search::fs_search,
            search::fs_search_cancel,
            dev_environments::list_dev_environments,
            dev_environments::launch_dev_environment,
            agent_registry::list_installed_agent_commands,
            commands::agent_hooks_provision,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // The first time the app receives an exit request (Cmd+Q, app
            // menu Quit, our own `app.exit(0)`), snapshot the full set of
            // open windows and their profiles to windows.json. Subsequent
            // window Destroyed events see the QuittingFlag and skip their
            // per-window save logic, preserving the full pre-quit set.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let already_handled = app_handle
                    .try_state::<profile_store::QuittingFlag>()
                    .map(|f| {
                        let mut guard = f.0.lock().unwrap();
                        let was = *guard;
                        *guard = true;
                        was
                    })
                    .unwrap_or(true);
                if already_handled {
                    return;
                }
                if let Some(state) =
                    app_handle.try_state::<profile_store::ActiveProfileState>()
                {
                    let snapshot = window_persistence::snapshot_from_state(&state);
                    if let Err(e) = window_persistence::save(&snapshot) {
                        eprintln!(
                            "[abundio] failed to persist windows.json at exit: {e}"
                        );
                    }
                }
            }
        });
}

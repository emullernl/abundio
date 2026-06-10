pub mod agent_hooks;
pub mod agent_registry;
pub mod app_metrics;
pub mod clipboard_image;
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
pub mod updater;
pub mod window_management;
pub mod window_persistence;
pub mod workspace_store;
pub mod worktree_commands;
pub mod worktree_watcher;
pub mod shell_env;

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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
        copyright: Some("Copyright © 2026 Emil Müller and contributors".to_string()),
        license: Some("MIT OR Apache-2.0".to_string()),
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

/// Runs the actual app quit: marks the `QuittingFlag` so per-window `Destroyed`
/// events skip their incremental `windows.json` saves, snapshots the full
/// pre-quit window set, applies any staged update, then exits. Shared by the
/// confirmed and no-confirmation-needed quit-app paths. See ADR-0016 / ADR-0007.
fn perform_quit(app: &AppHandle<Wry>) {
    if let Some(flag) = app.try_state::<profile_store::QuittingFlag>() {
        *flag.0.lock().unwrap() = true;
    }
    if let Some(state) = app.try_state::<profile_store::ActiveProfileState>() {
        let snapshot = window_persistence::snapshot_from_state(&state);
        if let Err(e) = window_persistence::save(&snapshot) {
            eprintln!("[abundio] failed to persist windows.json at quit: {e}");
        }
    }
    // Apply a staged update (if any) on this quit — the default "install on
    // quit" contract. See ADR-0014.
    updater::apply_staged_update_on_quit(app);
    app.exit(0);
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

/// Before the window-state plugin loads its geometry cache, make the main
/// window adopt a surviving window's saved geometry when the user closed the
/// main window last session. Without this, a survivor that takes over the main
/// window (see `plan_restoration`) would appear at the *old* main window's
/// position/size rather than its own. Best-effort: any failure leaves the main
/// window at its own saved geometry. MUST run before the window-state plugin's
/// setup reads `.window-state.json` into its in-memory cache.
///
/// Returns the computed `RestorationPlan` in the (rare) case where it opened the
/// DB, so `setup()` can reuse the *exact same* plan instead of recomputing it —
/// this guarantees the profile restoration matches the geometry migration just
/// performed and avoids a second DB open. Returns `None` on the common fast
/// path (a persisted "main" entry exists, so no adoption is possible), where
/// `setup()` computes the plan itself.
fn adopt_survivor_geometry_into_main() -> Option<window_persistence::RestorationPlan> {
    let entries = window_persistence::load();
    let main_label = window_management::MAIN_WINDOW_LABEL;

    // Fast path: only the "main entry missing, another profile window survives"
    // case can require adoption. Checking windows.json alone avoids the DB open
    // + migration run on the common launch path, keeping it off first paint.
    let has_main = entries.iter().any(|e| e.label == main_label);
    let has_survivor = entries
        .iter()
        .any(|e| e.label != main_label && window_management::is_profile_window_label(&e.label));
    if has_main || !has_survivor {
        return None;
    }

    let conn = migrations::open_db().ok()?;
    let profile_store = ProfileStore::new(conn);
    let all_profiles = profile_store.list().ok()?;
    let valid_ids: std::collections::HashSet<&str> =
        all_profiles.iter().map(|p| p.id.as_str()).collect();
    let plan = window_persistence::plan_restoration(
        entries,
        &valid_ids,
        main_label,
        all_profiles.first().map(|p| p.id.as_str()),
    );
    if let Some(from_label) = &plan.main_adopted_label {
        migrate_main_geometry(from_label, main_label);
    }
    Some(plan)
}

/// Copies `from_label`'s geometry onto the main window's key inside the
/// window-state plugin's `.window-state.json`, atomically (tmp + rename). A
/// half-written file would make the plugin reset *all* window geometries on the
/// next launch, not just the adopted one — hence the same tmp+rename pattern as
/// `window_persistence::save()`.
fn migrate_main_geometry(from_label: &str, main_label: &str) {
    // The plugin stores geometry at <app_config_dir>/.window-state.json, where
    // app_config_dir = config_dir()/<bundle identifier> (see tauri.conf.json's
    // "identifier"). We're pre-Builder here, so resolve the path ourselves.
    let Some(path) = dirs::config_dir().map(|d| {
        d.join("com.abundio.desktop")
            .join(tauri_plugin_window_state::DEFAULT_FILENAME)
    }) else {
        return;
    };
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        // No file yet (first-ever launch) is expected; only surface real errors.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            eprintln!("[abundio] failed to read window-state for geometry adoption: {e}");
            return;
        }
    };
    let Some(rewritten) =
        window_persistence::migrate_geometry_to_main(&contents, from_label, main_label)
    else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, rewritten) {
        eprintln!("[abundio] failed to write window-state geometry adoption: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        eprintln!("[abundio] failed to commit window-state geometry adoption: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must happen before the window-state plugin is initialised below. Returns
    // the precomputed plan (rare case) for setup() to reuse.
    let preplan = adopt_survivor_geometry_into_main();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
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
            // Per-window Opened-workspace counts (pushed by the frontend),
            // summed at quit time to drive the quit confirmation. See ADR-0016.
            app.manage(profile_store::OpenedCountState::default());
            // Guards against stacking quit-confirmation dialogs on a repeated
            // Cmd+Q (the native dialog is non-blocking). See ADR-0016.
            app.manage(profile_store::QuitConfirmInFlight::default());

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
            // Per-repo live-sync watcher for git worktree add/remove. See ADR-0017.
            app.manage(worktree_watcher::WorktreeWatcher::new());

            // Initialize search manager
            app.manage(search::SearchManager::new());

            // In-app updater state + background auto-check loop. The check runs
            // in Rust and emits `update-available` to the focused Window; the
            // loop honours the frontend's auto-check setting. See ADR-0014.
            app.manage(updater::UpdaterState::new());
            updater::start_auto_check(app.handle().clone());

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

            // One-shot guard so startup hook provisioning runs a single time
            // per process even though every Window's settings rehydrate calls
            // `agent_hooks_provision_startup`. See ADR-0003 (Revisited).
            app.manage(agent_hooks::StartupProvisionGuard::default());

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

            let main_label = window_management::MAIN_WINDOW_LABEL;

            // Decide which profile the always-present main window adopts and
            // which additional windows to spawn. See plan_restoration — closing
            // the main window while others stay open must NOT resurrect it.
            // Reuse the plan already computed by the pre-Builder geometry step
            // when present, so the profile restoration matches the geometry
            // migration exactly (and we skip a redundant DB read); otherwise
            // compute it here (the common, no-adoption launch path).
            let plan = preplan.unwrap_or_else(|| {
                window_persistence::plan_restoration(
                    window_persistence::load(),
                    &valid_ids,
                    main_label,
                    all_profiles.first().map(|p| p.id.as_str()),
                )
            });
            if let Some(pid) = plan.main_profile_id {
                active_state.set_for_window(main_label, &pid);
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
            let additional = plan.additional;
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
                // Drop this window's worktree watch contribution so closed
                // Windows don't keep repos watched forever. See ADR-0017.
                if let Some(ww) =
                    app_handle.try_state::<worktree_watcher::WorktreeWatcher>()
                {
                    ww.forget_window(&app_handle, &label);
                }
                // Drop this window's Opened-workspace count so it can't inflate
                // the quit-time total. See ADR-0016.
                if let Some(counts) =
                    app_handle.try_state::<profile_store::OpenedCountState>()
                {
                    counts.remove_for_window(&label);
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
                //
                // Confirm first if any Opened workspaces (live agents / PTYs)
                // would be lost. The per-window counts live in each window's
                // frontend and are mirrored into OpenedCountState, so this is
                // the only place a cross-window total exists. Shown as a NATIVE
                // dialog because the quit decision runs here in Rust (the
                // frontend never sees the quit-app path) and it must work even
                // if a webview is hung. This gates ONLY the custom quit-app menu
                // item (Cmd+Q / "Quit Abundio"); dock-icon Quit and OS shutdown
                // go through ExitRequested AFTER windows tear down — too late to
                // gate gracefully. See ADR-0016.
                let total_opened = app
                    .try_state::<profile_store::OpenedCountState>()
                    .map(|s| s.total())
                    .unwrap_or(0);
                if total_opened > 0 {
                    // The native dialog is non-blocking, so a second Cmd+Q while
                    // it's open would re-enter here and stack another dialog.
                    // Skip if one is already in flight. See ADR-0016.
                    if let Some(flag) =
                        app.try_state::<profile_store::QuitConfirmInFlight>()
                    {
                        let mut in_flight = flag.0.lock().unwrap();
                        if *in_flight {
                            return;
                        }
                        *in_flight = true;
                    }
                    let window_count = app
                        .webview_windows()
                        .keys()
                        .filter(|l| window_management::is_profile_window_label(l))
                        .count();
                    let message =
                        window_management::quit_confirm_message(total_opened, window_count);
                    let app_handle = app.clone();
                    // Non-blocking: the callback fires when the dialog is
                    // dismissed. Returning from the menu handler without exiting
                    // is safe — quit-app is a custom MenuItem with no default
                    // behaviour, so nothing quits unless we say so.
                    app.dialog()
                        .message(message)
                        .title("Quit Abundio?")
                        .kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Quit Abundio".to_string(),
                            "Cancel".to_string(),
                        ))
                        .show(move |confirmed| {
                            // Clear the in-flight guard on both paths so a later
                            // cancelled quit can re-prompt.
                            if let Some(flag) =
                                app_handle.try_state::<profile_store::QuitConfirmInFlight>()
                            {
                                *flag.0.lock().unwrap() = false;
                            }
                            if confirmed {
                                perform_quit(&app_handle);
                            }
                        });
                    return;
                }
                perform_quit(app);
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
            commands::report_opened_workspace_count,
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
            worktree_commands::list_repo_worktrees,
            worktree_commands::worktree_add,
            worktree_commands::worktree_remove,
            worktree_commands::worktree_dirty,
            commands::worktree_watch_set,
            gh_commands::gh_status,
            gh_commands::gh_review_requests,
            gh_commands::gh_review_requests_all,
            gh_commands::gh_my_prs,
            gh_commands::gh_my_prs_all,
            commands::list_system_fonts,
            commands::list_available_shells,
            commands::default_shell,
            search::fs_search,
            search::fs_search_cancel,
            dev_environments::list_dev_environments,
            dev_environments::launch_dev_environment,
            agent_registry::list_installed_agent_commands,
            commands::agent_hooks_provision,
            commands::agent_hooks_provision_startup,
            commands::ensure_agent_hooks,
            commands::agent_hook_status,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install_now,
            updater::updater_set_auto_check,
            clipboard_image::set_clipboard_image_from_path,
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
                // Apply a staged update (if any) AFTER persisting windows.json,
                // so the restoration snapshot is never lost to a stalled or
                // failed install. The quit-app menu path already applied it (and
                // also saved first), so this covers the direct ExitRequested
                // paths (dock quit, OS shutdown). See ADR-0014.
                updater::apply_staged_update_on_quit(app_handle);
            }
        });
}

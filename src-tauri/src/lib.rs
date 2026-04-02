pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod file_explorer;
pub mod file_watcher;
pub mod gh_commands;
pub mod git_commands;
pub mod migrations;
pub mod pty_manager;
pub mod session_store;
pub mod shell_env;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

use pty_manager::PtyManager;
use session_store::SessionStore;

fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let handle = app.handle();
    let pkg = handle.package_info();

    let about_metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let settings_item =
        MenuItem::with_id(handle, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;

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
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    // File menu
    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(handle, None)?],
    )?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &settings_item,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
            &PredefinedMenuItem::quit(handle, None)?,
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

    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
        ],
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
            &help_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            // Build and set the application menu
            let menu = build_menu(app)?;
            app.set_menu(menu)?;

            // Initialize SQLite + run migrations
            let conn = migrations::open_db().expect("Failed to open database");
            let store = SessionStore::new(conn);
            app.manage(store);

            // Initialize PTY manager
            let pty_mgr = PtyManager::new();
            app.manage(pty_mgr);

            // Initialize file watcher
            app.manage(file_watcher::FileWatcher::new());

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                let _ = app.emit("open-settings", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::session_create,
            commands::session_list,
            commands::session_update,
            commands::session_delete,
            commands::session_reorder,
            commands::pty_read_log,
            commands::pty_write_snapshot,
            commands::pty_read_snapshot,
            commands::pty_delete_log,
            commands::pty_cleanup_stale_logs,
            commands::tab_create,
            commands::tab_list,
            commands::tab_update,
            commands::tab_delete,
            file_explorer::fs_list_dir,
            file_explorer::fs_read_file,
            file_explorer::fs_write_file,
            file_explorer::fs_file_exists,
            commands::fs_watch_start,
            commands::fs_watch_stop,
            git_commands::git_changed_files,
            git_commands::git_file_diff,
            git_commands::git_branch_info,
            git_commands::git_list_branches,
            git_commands::git_status_fingerprint,
            gh_commands::gh_status,
            gh_commands::gh_review_requests,
            gh_commands::gh_review_requests_all,
            gh_commands::gh_my_prs,
            gh_commands::gh_my_prs_all,
            commands::list_system_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

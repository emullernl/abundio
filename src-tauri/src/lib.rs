pub mod agent_registry;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod file_explorer;
pub mod migrations;
pub mod pty_manager;
pub mod session_store;
pub mod shell_env;

use tauri::Manager;

use agent_registry::AgentRegistry;
use pty_manager::PtyManager;
use session_store::SessionStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            // Initialize SQLite + run migrations
            let conn = migrations::open_db().expect("Failed to open database");
            let store = SessionStore::new(conn);
            app.manage(store);

            // Initialize PTY manager
            let pty_mgr = PtyManager::new();
            app.manage(pty_mgr);

            // Detect available agents (cached at startup)
            let registry = AgentRegistry::new();
            app.manage(registry);

            Ok(())
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
            commands::agents_list_available,
            commands::agents_refresh,
            commands::agent_spawn,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

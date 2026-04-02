use tauri::{AppHandle, State};

use crate::error::AbundioError;
use crate::file_watcher::FileWatcher;
use crate::pty_manager::PtyManager;
use crate::session_store::{SessionStore, SessionUpdate, SessionWithTabs, Tab, TabUpdate};

// ── PTY commands ──

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    pty_mgr: State<'_, PtyManager>,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    log_id: Option<String>,
) -> Result<String, AbundioError> {
    pty_mgr.spawn(app, &cwd, command.as_deref(), cols, rows, log_id.as_deref())
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

// ── Session commands ──

#[tauri::command]
pub async fn session_create(
    store: State<'_, SessionStore>,
    name: String,
    root_folder: String,
) -> Result<SessionWithTabs, AbundioError> {
    store.create(&name, &root_folder)
}

#[tauri::command]
pub async fn session_list(store: State<'_, SessionStore>) -> Result<Vec<SessionWithTabs>, AbundioError> {
    store.list()
}

#[tauri::command]
pub async fn session_update(
    store: State<'_, SessionStore>,
    id: String,
    updates: SessionUpdate,
) -> Result<(), AbundioError> {
    store.update(&id, updates)
}

#[tauri::command]
pub async fn session_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete(&id)
}

#[tauri::command]
pub async fn session_reorder(
    store: State<'_, SessionStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder_sessions(&ids)
}

// ── Tab commands ──

#[tauri::command]
pub async fn tab_create(
    store: State<'_, SessionStore>,
    session_id: String,
    name: String,
) -> Result<Tab, AbundioError> {
    store.create_tab(&session_id, &name)
}

#[tauri::command]
pub async fn tab_list(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<Tab>, AbundioError> {
    store.list_tabs(&session_id)
}

#[tauri::command]
pub async fn tab_update(
    store: State<'_, SessionStore>,
    id: String,
    updates: TabUpdate,
) -> Result<(), AbundioError> {
    store.update_tab(&id, updates)
}

#[tauri::command]
pub async fn tab_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete_tab(&id)
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

// ── Font commands ──

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, AbundioError> {
    let source = font_kit::source::SystemSource::new();
    let families = source.all_families().map_err(|e| {
        AbundioError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;
    Ok(families)
}

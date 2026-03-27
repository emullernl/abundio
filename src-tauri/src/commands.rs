use tauri::{AppHandle, State};

use crate::agent_registry::{AgentInfo, AgentRegistry};
use crate::error::AbundioError;
use crate::pty_manager::PtyManager;
use crate::session_store::{Session, SessionStore, SessionUpdate};

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
) -> Result<Session, AbundioError> {
    store.create(&name, &root_folder)
}

#[tauri::command]
pub async fn session_list(store: State<'_, SessionStore>) -> Result<Vec<Session>, AbundioError> {
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

// ── Agent commands ──

#[tauri::command]
pub async fn agents_list_available(
    registry: State<'_, AgentRegistry>,
) -> Result<Vec<AgentInfo>, AbundioError> {
    Ok(registry.list())
}

#[tauri::command]
pub async fn agents_refresh(registry: State<'_, AgentRegistry>) -> Result<(), AbundioError> {
    registry.refresh();
    Ok(())
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    pty_mgr: State<'_, PtyManager>,
    registry: State<'_, AgentRegistry>,
    session_id: String,
    agent_name: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, AbundioError> {
    let agent = registry
        .get(&agent_name)
        .ok_or_else(|| AbundioError::NotFound(format!("Agent not found: {}", agent_name)))?;

    if !agent.available {
        return Err(AbundioError::NotFound(format!(
            "Agent not installed: {}",
            agent_name
        )));
    }

    // Build command string: binary + default args
    let mut parts = vec![agent.binary.clone()];
    parts.extend(agent.default_args.clone());
    let command = parts.join(" ");

    let _ = session_id; // Will be used for session-specific env in the future
    pty_mgr.spawn(app, &cwd, Some(&command), cols, rows, None)
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

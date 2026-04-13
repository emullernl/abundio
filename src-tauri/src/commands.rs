use tauri::{AppHandle, State};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::error::AbundioError;
use crate::file_watcher::FileWatcher;
use crate::plugins::{self, Plugin};
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
) -> Result<String, AbundioError> {
    pty_mgr.spawn(app, &cwd, command.as_deref(), shell.as_deref(), cols, rows, log_id.as_deref(), pty_id.as_deref())
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

// ── Workspace commands ──

#[tauri::command]
pub async fn workspace_create(
    store: State<'_, WorkspaceStore>,
    name: String,
    root_folder: String,
) -> Result<WorkspaceWithTabs, AbundioError> {
    store.create(&name, &root_folder)
}

#[tauri::command]
pub async fn workspace_list(store: State<'_, WorkspaceStore>) -> Result<Vec<WorkspaceWithTabs>, AbundioError> {
    store.list()
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
    let families = tauri::async_runtime::spawn_blocking(|| {
        font_kit::source::SystemSource::new()
            .all_families()
            .map_err(|e| AbundioError::Font(e.to_string()))
    })
    .await
    .map_err(|e| AbundioError::Font(e.to_string()))??;
    Ok(families)
}

// ── Plugin commands ──

#[tauri::command]
pub async fn list_plugins(plugins: State<'_, Vec<Plugin>>) -> Result<Vec<Plugin>, AbundioError> {
    Ok(plugins.inner().clone())
}

#[tauri::command]
pub async fn open_plugins_directory() -> Result<String, AbundioError> {
    let dir = plugins::ensure_user_plugins_dir()?;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(&dir);
        cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
        cmd.spawn()?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn()?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn()?;
    }

    Ok(dir.to_string_lossy().to_string())
}

// ── Salesforce commands ──

#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct SalesforceOrg {
    pub org_id: String,
    pub username: String,
    pub alias: Option<String>,
    pub instance_url: String,
    pub is_default: bool,
}

#[tauri::command]
pub async fn sf_org_list() -> Result<Vec<SalesforceOrg>, AbundioError> {
    let output = run_sf_command(&["org:list", "--json"])?;
    let orgs: Vec<SalesforceOrg> = serde_json::from_str(&output)
        .map_err(|e| AbundioError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))?;
    Ok(orgs)
}

#[tauri::command]
pub async fn sf_set_default_org(org_id: String) -> Result<(), AbundioError> {
    run_sf_command(&["config:set", &format!("target-org={}", org_id)])?;
    Ok(())
}

#[tauri::command]
pub async fn sf_open_org(org_id: String) -> Result<(), AbundioError> {
    run_sf_command(&["org:open", "--target-org", &org_id])?;
    Ok(())
}

#[tauri::command]
pub async fn sf_deploy(source_path: String, org_id: String) -> Result<String, AbundioError> {
    let output = run_sf_command(&["project:deploy:start", "--source-dir", &source_path, "--target-org", &org_id, "--json"])?;
    Ok(output)
}

fn run_sf_command(args: &[&str]) -> Result<String, AbundioError> {
    use std::process::Command;
    let output = Command::new("sf")
        .args(args)
        .output()
        .map_err(|e| AbundioError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, format!("sf command not found: {}", e))))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(AbundioError::Io(std::io::Error::new(std::io::ErrorKind::Other, String::from_utf8_lossy(&output.stderr))))
    }
}

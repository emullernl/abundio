use tauri::{AppHandle, State};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::collections::HashMap;

use crate::error::AbundioError;
use crate::file_watcher::FileWatcher;
use crate::plugins::{self, Plugin, PluginCommand};
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

#[tauri::command]
pub async fn plugin_invoke(
    plugins: State<'_, Vec<Plugin>>,
    plugin_id: String,
    command_id: String,
    args: Option<HashMap<String, String>>,
) -> Result<String, AbundioError> {
    let Some(plugin) = plugins.iter().find(|plugin| plugin.id == plugin_id) else {
        return Err(AbundioError::NotFound(format!("plugin {}", plugin_id)));
    };

    let Some(command) = plugin
        .manifest
        .commands
        .iter()
        .find(|command| command.id == command_id)
    else {
        return Err(AbundioError::NotFound(format!(
            "plugin command {}.{}",
            plugin_id, command_id
        )));
    };

    run_plugin_command(plugin, command, args.unwrap_or_default())
}

fn run_plugin_command(
    plugin: &Plugin,
    command: &PluginCommand,
    args: HashMap<String, String>,
) -> Result<String, AbundioError> {
    let executable = interpolate_template(&command.executable, plugin, &args)?;
    let resolved_executable = crate::shell_env::resolve_command_path(&executable)
        .unwrap_or(executable.clone());
    let resolved_args: Result<Vec<_>, _> = command
        .args
        .iter()
        .map(|value| interpolate_template(value, plugin, &args))
        .collect();
    let resolved_args = resolved_args?;

    let mut process = if command.run_in_shell {
        let shell = crate::shell_env::default_shell();
        let mut shell_cmd = std::process::Command::new(&shell);

        #[cfg(target_os = "windows")]
        {
            let lower = shell.to_ascii_lowercase();
            let command_line = shell_command_line(&resolved_executable, &resolved_args, true);
            if lower.contains("bash") {
                shell_cmd.arg("-l").arg("-i").arg("-c").arg(command_line);
            } else if lower.ends_with("pwsh.exe") || lower.ends_with("powershell.exe") {
                shell_cmd.arg("-Command").arg(command_line);
            } else {
                shell_cmd.arg("/C").arg(command_line);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let command_line = shell_command_line(&resolved_executable, &resolved_args, false);
            shell_cmd.arg("-l").arg("-i").arg("-c").arg(command_line);
        }

        shell_cmd
    } else {
        let mut direct = std::process::Command::new(&resolved_executable);

        #[cfg(target_os = "windows")]
        {
            let lower = resolved_executable.to_ascii_lowercase();
            if lower.ends_with(".cmd") || lower.ends_with(".bat") {
                direct = std::process::Command::new("cmd.exe");
                direct.arg("/C").arg(&resolved_executable).args(&resolved_args);
            } else {
                direct.args(&resolved_args);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            direct.args(&resolved_args);
        }

        direct
    };

    process.env("PATH", crate::shell_env::shell_path());

    if let Some(cwd) = &command.cwd {
        process.current_dir(interpolate_template(cwd, plugin, &args)?);
    }

    #[cfg(target_os = "windows")]
    {
        process.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
    }

    let output = process.output().map_err(|error| {
        AbundioError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("failed to start plugin command {}: {}", command.id, error),
        ))
    })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("plugin command {} failed with status {}", command.id, output.status)
        };

        Err(AbundioError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            message,
        )))
    }
}

fn shell_command_line(executable: &str, args: &[String], windows: bool) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(shell_escape(executable, windows));
    for arg in args {
        parts.push(shell_escape(arg, windows));
    }
    parts.join(" ")
}

fn shell_escape(value: &str, windows: bool) -> String {
    if windows {
        let escaped = value.replace('"', "\\\"");
        format!("\"{}\"", escaped)
    } else {
        let escaped = value.replace('\'', "'\\''");
        format!("'{}'", escaped)
    }
}

fn interpolate_template(
    template: &str,
    plugin: &Plugin,
    args: &HashMap<String, String>,
) -> Result<String, AbundioError> {
    let mut resolved = template.replace("{{pluginDir}}", &plugin.dir);

    for (key, value) in args {
        resolved = resolved.replace(&format!("{{{{{}}}}}", key), value);
    }

    if resolved.contains("{{") {
        return Err(AbundioError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("unresolved template value in '{}'", template),
        )));
    }

    Ok(resolved)
}

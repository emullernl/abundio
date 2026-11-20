//! `host_call`: the desktop app's door to the host commands for a local
//! Profile (docs/plans/remote-hosts.md phase 7b). The commands themselves are
//! in the core (`host_api.rs`), where an Abundio server runs the same code.

use serde_json::Value;
use tauri::{AppHandle, Manager, Window};

use crate::error::AbundioError;
use crate::event_sink::ClientId;
use crate::host_api::{Host, HostClients};

/// This app's Windows, as Clients of its own Host.
struct DesktopClients(AppHandle);

impl HostClients for DesktopClients {
    fn profiles(&self) -> std::collections::HashMap<String, String> {
        self.0.state::<crate::profile_store::ActiveProfileState>().snapshot()
    }

    /// Tauri drops a Window from its list before our `Destroyed` handler
    /// kills its PTYs (tauri-runtime-wry 2.11.2), so a spawn either lands
    /// before that sweep or sees the Window gone here. Re-check this ordering
    /// when upgrading Tauri.
    fn is_alive(&self, client: &ClientId) -> bool {
        self.0.get_webview_window(client.as_str()).is_some()
    }
}

fn with_host<R>(app: &AppHandle, f: impl FnOnce(&Host) -> R) -> R {
    let workspaces = app.state::<crate::workspace_store::WorkspaceStore>();
    let ptys = app.state::<crate::pty_manager::PtyManager>();
    let status = app.state::<std::sync::Arc<crate::status_store::StatusStore>>();
    let layouts = app.state::<std::sync::Arc<crate::layout_store::LayoutStore>>();
    let facts = app.state::<crate::pane_facts::PaneFactsStore>();
    let agents = app.state::<std::sync::Arc<crate::shell_integration::AgentCommands>>();
    let events = app.state::<crate::event_sink::Events>();
    let env = app.try_state::<crate::env_vars::EnvVarStore>();
    let hook_env = app
        .try_state::<crate::hook_server::HookServer>()
        .map(|h| crate::pty_manager::HookEnv { port: h.port, token: h.token.clone() });
    let clients = DesktopClients(app.clone());
    let files = app.state::<crate::file_watcher::FileWatcher>();
    let git = app.state::<crate::git_scheduler::GitScheduler>();
    let worktrees = app.state::<crate::worktree_watcher::WorktreeWatcher>();
    let search = app.state::<crate::search::SearchManager>();
    f(&Host {
        workspaces: &workspaces,
        ptys: &ptys,
        status: &status,
        layouts: &layouts,
        facts: &facts,
        agents: &agents,
        env: env.as_deref(),
        hook_env,
        events: &events,
        clients: &clients,
        files: &files,
        git: &git,
        worktrees: &worktrees,
        search: &search,
    })
}

fn call(app: &AppHandle, client: &ClientId, command: &str, args: Value) -> Result<Value, AbundioError> {
    with_host(app, |host| crate::host_api::dispatch(host, client, command, args))
        .unwrap_or_else(|| Err(AbundioError::NotFound(format!("no host command {command}"))))
}

/// Run one host command for the calling Window.
#[tauri::command]
pub async fn host_call(app: AppHandle, window: Window, command: String, args: Value) -> Result<Value, AbundioError> {
    let client = ClientId::from(window.label());
    if crate::host_api::may_block(&command) {
        // Off the async runtime: a `stat` on a hung mount can block for long.
        tauri::async_runtime::spawn_blocking(move || call(&app, &client, &command, args))
            .await
            .map_err(|e| AbundioError::InvalidOperation(format!("{e}")))?
    } else {
        call(&app, &client, &command, args)
    }
}

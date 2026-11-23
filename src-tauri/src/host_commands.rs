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

/// Everything the host commands reach, from the app's managed state.
pub(crate) fn with_host<R>(app: &AppHandle, f: impl FnOnce(&Host) -> R) -> R {
    let workspaces = app.state::<crate::workspace_store::WorkspaceStore>();
    let profiles = app.state::<crate::profile_store::ProfileStore>();
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
    let prompt_actions = app.state::<crate::prompt_actions::PromptActionStore>();
    let handles = app.state::<crate::agent_names::HandleReservations>();
    let hooks_guard = app.state::<crate::agent_hooks::StartupProvisionGuard>();
    let skill_guard = app.state::<crate::agent_skills::SkillStartupGuard>();
    let pending = app.state::<crate::control_protocol::PendingRequests>();
    let waits = app.state::<crate::control_protocol::WaitGraph>();
    f(&Host {
        workspaces: &workspaces,
        profiles: &profiles,
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
        prompt_actions: &prompt_actions,
        handles: &handles,
        hooks_guard: &hooks_guard,
        skill_guard: &skill_guard,
        pending: &pending,
        waits: &waits,
    })
}

fn call(app: &AppHandle, client: &ClientId, command: &str, args: Value) -> Result<Value, AbundioError> {
    with_host(app, |host| crate::host_api::dispatch(host, client, command, args))
        .unwrap_or_else(|| Err(AbundioError::NotFound(format!("no host command {command}"))))
}

/// The app's Windows as a remote Host's router sees them (phase 7c): its
/// events under their own names, its PTY bytes on their output channels.
pub struct RouterWindows(pub AppHandle);

impl crate::host_router::WindowSink for RouterWindows {
    fn emit_to(&self, window: &str, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit_to(window, event, payload);
    }
    fn pty_frame(&self, window: &str, frame: &[u8]) {
        self.0.state::<std::sync::Arc<crate::tauri_sink::PtyChannels>>().send_to(window, frame);
    }
}

fn router(app: &AppHandle) -> std::sync::Arc<crate::host_router::HostRouter> {
    app.state::<std::sync::Arc<crate::host_router::HostRouter>>().inner().clone()
}

/// What a remote Host's failure looks like to the Window: the command's own
/// error when it ran there.
pub(crate) fn remote_error(e: crate::host_router::CallError) -> AbundioError {
    use crate::host_router::CallError;
    match e {
        CallError::Failed(Value::String(s)) => AbundioError::InvalidOperation(s),
        CallError::Failed(v) => AbundioError::InvalidOperation(v.to_string()),
        CallError::NotConnected(host) => AbundioError::Channel(format!("not connected to {host}")),
        CallError::ConnectionLost => AbundioError::Channel(
            "the connection to the Host was lost; the action may have happened, so check before retrying".into(),
        ),
    }
}

/// Settings a Window pushes to its backend that every backend it shows must
/// have (phase 10): sent to each Host it joined too. Only what is the
/// user's, not a machine's: Host settings (ADR-0064) are each Host's own.
const TO_EVERY_BACKEND: &[&str] = &["status_byte_threshold_set"];

/// Run one host command for the calling Window: on its Host when it is on
/// one (phase 7c), here otherwise. `host` sends it to another backend the
/// Window shows (phase 10, a Joined profile's Workspace): a Host's id, or
/// `local` for this computer.
#[tauri::command]
pub async fn host_call(
    app: AppHandle,
    window: Window,
    command: String,
    args: Value,
    host: Option<String>,
) -> Result<Value, AbundioError> {
    let client = ClientId::from(window.label());
    let router = router(&app);
    let own = router.host_of(client.as_str());
    // A reply goes back to the Host that asked.
    let host = match host {
        None if command == "agent_control_reply" => args
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| router.request_host(client.as_str(), id)),
        other => other,
    };
    let fan_out = TO_EVERY_BACKEND.contains(&command.as_str());
    if fan_out {
        for joined in router.joined_hosts(client.as_str()).into_iter().filter(|h| Some(h) != own.as_ref()) {
            let (router, client, command, args) = (router.clone(), client.clone(), command.clone(), args.clone());
            std::thread::spawn(move || {
                if let Err(e) = router.call_on(&joined, client.as_str(), &command, args) {
                    log::debug!("[host] {command} on joined {joined}: {e:?}");
                }
            });
        }
    }
    match host.as_deref() {
        Some("local") if own.is_some() => return local_call(app, client, command, args).await,
        Some(h) if Some(h) != own.as_deref() && h != "local" => {
            let h = h.to_string();
            return tauri::async_runtime::spawn_blocking(move || {
                router.call_on(&h, client.as_str(), &command, args).map_err(remote_error)
            })
            .await
            .map_err(|e| AbundioError::InvalidOperation(format!("{e}")))?;
        }
        _ => {}
    }
    if own.is_some() {
        // A request over the connection waits for its answer: never on the
        // async runtime.
        return tauri::async_runtime::spawn_blocking(move || {
            router.call(client.as_str(), &command, args).expect("bound").map_err(remote_error)
        })
        .await
        .map_err(|e| AbundioError::InvalidOperation(format!("{e}")))?;
    }
    local_call(app, client, command, args).await
}

async fn local_call(app: AppHandle, client: ClientId, command: String, args: Value) -> Result<Value, AbundioError> {
    if crate::host_api::may_block(&command) {
        // Off the async runtime: a `stat` on a hung mount can block for long.
        tauri::async_runtime::spawn_blocking(move || call(&app, &client, &command, args))
            .await
            .map_err(|e| AbundioError::InvalidOperation(format!("{e}")))?
    } else {
        call(&app, &client, &command, args)
    }
}

/// Connect to a Host (once per Host for the whole app). Blocks for the
/// handshake, so a password prompt waits for the user. Used by the
/// development console helper (`main.tsx`); the app connects through
/// `remote_windows::connect`.
#[tauri::command]
pub async fn host_connect(
    app: AppHandle,
    host: String,
    target: crate::host_router::HostTarget,
) -> Result<String, AbundioError> {
    let router = router(&app);
    tauri::async_runtime::spawn_blocking(move || router.connect(&host, &target, &crate::host_router::ConnectMode::Batch))
        .await
        .map_err(|e| AbundioError::InvalidOperation(format!("{e}")))?
        .map_err(AbundioError::Channel)
}

/// Put the calling Window on `host` (`None`: back on this computer); its
/// host commands then go there.
#[tauri::command]
pub fn host_bind(app: AppHandle, window: Window, host: Option<String>) {
    router(&app).bind(window.label(), host.as_deref());
}

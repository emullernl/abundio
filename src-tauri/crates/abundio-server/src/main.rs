//! **abundio-server**: Abundio on a Host with no window (ADR-0062,
//! docs/plans/remote-hosts.md phase 6). It keeps a Profile's Workspaces,
//! PTYs and Agents running, with their status, layouts and Agent control,
//! whether or not a desktop Client is connected.
//!
//! `run` starts the core services and waits: the database, the stores, the
//! PTY manager, the status scan, the hook server, and the socket desktop
//! apps connect to (`serve.rs`): `ssh <host> abundio-server connect` carries
//! one app's connection over SSH to it.
//!
//! Usage: `abundio-server run [--data-dir DIR]`, `abundio-server connect
//! [--data-dir DIR]`, `abundio-server version`.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod serve;

use abundio_core::event_sink::{ClientId, Events};
use abundio_core::events::AgentHookEvent;
use abundio_core::hook_server::{HookHost, HookServer};
use abundio_core::{
    agent_hooks, app_paths, change_hub, db_open, env_crypto, env_vars, file_watcher, git_scheduler,
    layout_store, migrations, pane_facts, pty_manager, search, status_machine, status_store,
    workspace_store, worktree_watcher,
};

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run { data_dir: Option<PathBuf> },
    Connect { data_dir: Option<PathBuf> },
    Version,
    Help,
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    match args.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => Ok(Command::Help),
        Some("version" | "--version" | "-V") => Ok(Command::Version),
        Some(cmd @ ("run" | "connect")) => {
            let mut data_dir = None;
            let mut rest = args[1..].iter();
            while let Some(a) = rest.next() {
                match a.as_str() {
                    "--data-dir" => {
                        let dir = rest.next().ok_or("--data-dir needs a folder")?;
                        data_dir = Some(PathBuf::from(dir));
                    }
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(if cmd == "run" { Command::Run { data_dir } } else { Command::Connect { data_dir } })
        }
        Some(other) => Err(format!("unknown command {other:?}; try `abundio-server help`")),
    }
}

const HELP: &str = "abundio-server: Abundio on a Host with no window.

  abundio-server run [--data-dir DIR]   Run in the foreground (systemd, a LaunchAgent).
                                        Data goes in DIR, by default ~/.abundio-server/data.
  abundio-server connect [--data-dir DIR]
                                        Carry stdin and stdout to the running server: what the
                                        desktop app runs over `ssh <host>`.
  abundio-server version                Print the version.

Logs go to stderr; set ABUNDIO_LOG=debug for more.";

/// Where the server keeps its data unless told otherwise. Never the desktop
/// app's folder: on a Mac that runs both, they must not share a database.
fn default_data_dir(home: &Path) -> PathBuf {
    home.join(".abundio-server").join("data")
}

// ── Logging ──

struct StderrLog {
    level: log::LevelFilter,
}

impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= self.level
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
            eprintln!("[{ts}] {} {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

fn init_log() {
    let level = match std::env::var("ABUNDIO_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        Ok("warn") => log::LevelFilter::Warn,
        _ => log::LevelFilter::Info,
    };
    let _ = log::set_logger(Box::leak(Box::new(StderrLog { level })));
    log::set_max_level(level);
}

/// The hook server's view of the server.
struct ServerHookHost {
    ptys: Arc<pty_manager::PtyManager>,
    env: Arc<env_vars::EnvVarStore>,
    status: Arc<status_store::StatusStore>,
    /// The host commands' view, set once it exists (it needs the hook
    /// server's port first); Agent control answers from it.
    host: std::sync::OnceLock<Arc<ServerHost>>,
}

impl HookHost for ServerHookHost {
    /// The status is kept here, Window or not (phase 6d); the owning Window,
    /// if one is connected, hears what the desktop app's would.
    fn hook_event(&self, pty_id: &str, event: AgentHookEvent) {
        use abundio_core::event_sink::EventsExt;
        log::debug!("hook {} from {} in {pty_id}", event.event, event.agent);
        let applied = abundio_core::hook_apply::apply(
            &self.status,
            pty_id,
            &event.agent,
            &event.event,
            &event.payload,
            abundio_core::hook_apply::now_ms(),
            &status_machine::StatusConfig::default(),
        );
        let Some(host) = self.host.get() else { return };
        let owner = self.status.owner(pty_id).or_else(|| self.ptys.owner_window(pty_id).map(ClientId));
        let Some(owner) = owner else { return };
        host.events.to_client(&owner, "agent-hook-applied", &applied.notice);
        if !applied.updates.is_empty() {
            host.events.to_client(&owner, "status-updates", applied.updates);
        }
    }
    fn ptys(&self) -> Option<&pty_manager::PtyManager> {
        Some(&self.ptys)
    }
    fn env_store(&self) -> Option<&env_vars::EnvVarStore> {
        Some(&self.env)
    }
    fn control_refuse_unknown(&self, request: tiny_http::Request) -> Option<tiny_http::Request> {
        match self.host.get() {
            Some(h) => h.with_host(|host| abundio_core::control_host::refuse_unknown(host, request)),
            None => {
                let body = r#"{"error":{"code":"unavailable","message":"the Abundio server is still starting"}}"#;
                let _ = request.respond(tiny_http::Response::from_string(body).with_status_code(503));
                None
            }
        }
    }
    fn control_serve(&self, request: tiny_http::Request) {
        if let Some(h) = self.host.get() {
            h.with_host(|host| abundio_core::control_host::serve(host, request));
        }
    }
}

// ── The host commands ──

/// What the server's Clients are: the Windows of the desktop apps connected
/// to it, each showing one of its Profiles.
struct ServerClients {
    connections: Arc<serve::Connections>,
    /// Client → the Profile it shows (phase 7d: set when a Window opens one).
    profiles: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl abundio_core::host_api::HostClients for ServerClients {
    fn profiles(&self) -> std::collections::HashMap<String, String> {
        self.profiles.lock().unwrap().clone()
    }
    fn is_alive(&self, client: &ClientId) -> bool {
        self.connections.has_client(client.as_str())
    }
    fn set_profile(&self, client: &ClientId, profile_id: &str) {
        self.profiles.lock().unwrap().insert(client.as_str().to_string(), profile_id.to_string());
    }
}

/// Everything the host commands reach on this server.
struct ServerHost {
    workspaces: Arc<workspace_store::WorkspaceStore>,
    profiles: abundio_core::profile_store::ProfileStore,
    env: Arc<env_vars::EnvVarStore>,
    ptys: Arc<pty_manager::PtyManager>,
    status: Arc<status_store::StatusStore>,
    layouts: layout_store::LayoutStore,
    facts: pane_facts::PaneFactsStore,
    agents: Arc<abundio_core::shell_integration::AgentCommands>,
    events: Events,
    hook_env: pty_manager::HookEnv,
    clients: ServerClients,
    files: file_watcher::FileWatcher,
    git: git_scheduler::GitScheduler,
    worktrees: worktree_watcher::WorktreeWatcher,
    search: search::SearchManager,
    prompt_actions: abundio_core::prompt_actions::PromptActionStore,
    handles: abundio_core::agent_names::HandleReservations,
    hooks_guard: agent_hooks::StartupProvisionGuard,
    skill_guard: abundio_core::agent_skills::SkillStartupGuard,
    pending: abundio_core::control_protocol::PendingRequests,
    waits: abundio_core::control_protocol::WaitGraph,
}

impl ServerHost {
    /// Each request runs the same host command a local Profile's Window
    /// runs (`host_api`), or one of the server's own (`serve.rs`).
    fn with_host<R>(&self, f: impl FnOnce(&abundio_core::host_api::Host) -> R) -> R {
        f(&abundio_core::host_api::Host {
                workspaces: &self.workspaces,
                profiles: &self.profiles,
                ptys: &self.ptys,
                status: &self.status,
                layouts: &self.layouts,
                facts: &self.facts,
                agents: &self.agents,
                env: Some(&self.env),
                hook_env: Some(self.hook_env.clone()),
                events: &self.events,
                clients: &self.clients,
                files: &self.files,
                git: &self.git,
                worktrees: &self.worktrees,
                search: &self.search,
                prompt_actions: &self.prompt_actions,
                handles: &self.handles,
                hooks_guard: &self.hooks_guard,
                skill_guard: &self.skill_guard,
                pending: &self.pending,
                waits: &self.waits,
        })
    }

    fn handler(self: Arc<Self>) -> serve::Handler {
        let builtin = serve::builtin_handler();
        Arc::new(move |client, command, args| {
            match self.with_host(|host| abundio_core::host_api::dispatch(host, client, command, args.clone())) {
                Some(result) => result
                    .map_err(|e| serde_json::to_value(&e).unwrap_or_else(|_| serde_json::Value::String(e.to_string()))),
                None => builtin(client, command, args),
            }
        })
    }
}

// ── Running ──

/// Holds the data folder for this process: a second server on the same
/// folder would fight over its database and its PTYs.
fn take_lock(root: &Path) -> Result<File, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    // The server's own: its socket, key and database are nobody else's.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }
    let path = root.join("server.lock");
    let mut file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Err(format!(
                "another abundio-server is already running with {}",
                root.display()
            ))
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(format!("cannot lock {}: {e}", path.display())),
    }
    let _ = file.set_len(0);
    let _ = writeln!(file, "{}", std::process::id());
    Ok(file)
}

/// The socket desktop apps connect to (through `connect`).
fn socket_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.sock")
}

/// The environment-variable master key: a file in the data folder, never
/// the OS credential store (see `env_crypto::use_key_file`).
fn key_file(data_dir: &Path) -> PathBuf {
    data_dir.join("env-master.key")
}

/// Everything a pane on this Host runs with, written into the data folder
/// now: the hook relay scripts, the shell-integration wrappers with the
/// `abundio` and `abundio-env` helpers, and the env key. None of it stops the
/// server: a pane still opens without hooks or environment variables.
fn prepare_data_folder(data_dir: &Path) {
    match agent_hooks::refresh_relay_scripts() {
        Ok(()) => log::info!("hook relay scripts in {}", app_paths::hooks_dir().display()),
        Err(e) => log::warn!("cannot write the hook relay scripts: {e}"),
    }
    let integration = pty_manager::prepare_shell_integration();
    log::info!("shell integration and the abundio command in {}", integration.display());
    match env_crypto::master_key() {
        Ok(_) => log::info!("environment variable key in {}", key_file(data_dir).display()),
        Err(e) => log::warn!("environment variables are unavailable: {e}"),
    }
}

fn open_db() -> Result<rusqlite::Connection, String> {
    db_open::open_with_retries(
        5,
        migrations::open_db,
        || std::thread::sleep(std::time::Duration::from_secs(1)),
        db_open::is_quietly_retryable,
    )
    .map_err(|e| {
        let (title, body) = db_open::failure_message(&e);
        format!("{title}: {body}")
    })
}

/// Block until SIGINT or SIGTERM. The signals are blocked first, in every
/// thread started after, so they wait here instead of killing the process.
#[cfg(unix)]
fn block_stop_signals() -> nix::sys::signal::SigSet {
    use nix::sys::signal::{SigSet, Signal};
    let mut set = SigSet::empty();
    set.add(Signal::SIGINT);
    set.add(Signal::SIGTERM);
    let _ = set.thread_block();
    set
}

fn run(data_dir: PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    let stop = block_stop_signals();

    app_paths::set_shared_root(data_dir.clone());
    env_crypto::use_key_file(key_file(&data_dir));
    let _lock = take_lock(&data_dir)?;
    log::info!("abundio-server {} with data in {}", env!("CARGO_PKG_VERSION"), data_dir.display());
    prepare_data_folder(&data_dir);

    let workspaces = Arc::new(workspace_store::WorkspaceStore::new(open_db()?));
    let env = Arc::new(env_vars::EnvVarStore::new(open_db()?));
    let ptys = Arc::new(pty_manager::PtyManager::new());
    let status = Arc::new(status_store::StatusStore::new());
    let agents = Arc::new(abundio_core::shell_integration::AgentCommands::default());
    let connections = Arc::new(serve::Connections::default());
    {
        // Skip-ahead (phase 9): a Client that fell behind gets the screen.
        let (shot, draw) = (Arc::downgrade(&ptys), Arc::downgrade(&ptys));
        connections.use_screens(serve::Screens {
            snapshot: Box::new(move |pty, send| shot.upgrade().is_some_and(|p| p.with_screen_snapshot(pty, send))),
            redraw: Box::new(move |pty| {
                if let Some(ptys) = draw.upgrade() {
                    let _ = ptys.redraw(pty);
                }
            }),
        });
    }
    let events: Events = connections.clone();
    {
        // A PTY's exit reaches its status here, Window or not (phase 6d).
        let (status, events) = (status.clone(), events.clone());
        ptys.on_exit(Arc::new(move |pty, code| {
            use abundio_core::event_sink::EventsExt;
            if let Some((owner, update)) = status.exit_update(pty, code, &status_machine::StatusConfig::default()) {
                events.to_client(&owner, "status-updates", vec![update]);
            }
        }));
    }
    status_store::listen_activity(&ptys, status.clone(), events.clone());
    abundio_core::shell_integration::listen(&ptys, status.clone(), agents.clone(), events.clone());
    abundio_core::title_status::listen(&ptys, status.clone(), events.clone());
    status_store::start_ticker(status.clone(), events.clone());

    // File changes reach the git scheduler inside the server, as in the app.
    let change_hub = Arc::new(change_hub::ChangeHub::new());
    let hook_host = Arc::new(ServerHookHost {
        ptys: ptys.clone(),
        env: env.clone(),
        status: status.clone(),
        host: Default::default(),
    });
    let hooks = HookServer::start(hook_host.clone())?;
    log::info!("hook server on 127.0.0.1:{}", hooks.port);
    let host = Arc::new(ServerHost {
        workspaces: workspaces.clone(),
        profiles: abundio_core::profile_store::ProfileStore::new(open_db()?),
        env,
        ptys: ptys.clone(),
        status: status.clone(),
        layouts: layout_store::LayoutStore::new(),
        facts: pane_facts::PaneFactsStore::new(),
        agents,
        events,
        hook_env: pty_manager::HookEnv { port: hooks.port, token: hooks.token.clone() },
        clients: ServerClients { connections: connections.clone(), profiles: Default::default() },
        files: file_watcher::FileWatcher::new(change_hub.clone()),
        git: git_scheduler::GitScheduler::new(change_hub),
        worktrees: worktree_watcher::WorktreeWatcher::new(),
        search: search::SearchManager::new(),
        prompt_actions: abundio_core::prompt_actions::PromptActionStore::new(open_db()?),
        handles: Default::default(),
        hooks_guard: Default::default(),
        skill_guard: Default::default(),
        pending: Default::default(),
        waits: Default::default(),
    });
    let _ = hook_host.host.set(host.clone());
    #[cfg(unix)]
    {
        // A Client going away never stops its PTYs: their status is kept,
        // no longer sent to it.
        let (status, gone_host) = (status.clone(), host.clone());
        let gone: serve::ClientGone = Arc::new(move |c: &ClientId| {
            status.release_client(c.as_str());
            gone_host.ptys.sizes.forget_client(c.as_str());
            gone_host.clients.profiles.lock().unwrap().remove(c.as_str());
        });
        serve::listen(&socket_path(&data_dir), connections, host.handler(), gone)?;
        log::info!("listening on {}", socket_path(&data_dir).display());
    }
    log::info!(
        "{} Workspace(s) in this data folder; waiting for a Client",
        workspaces.count().unwrap_or(0)
    );

    #[cfg(unix)]
    {
        let signal = stop.wait().map_err(|e| format!("waiting for a stop signal: {e}"))?;
        log::info!("{signal:?}: stopping");
    }
    #[cfg(not(unix))]
    loop {
        std::thread::park();
    }

    ptys.kill_all();
    log::info!("stopped");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("abundio-server: {e}");
            std::process::exit(2);
        }
    };
    match command {
        Command::Help => println!("{HELP}"),
        Command::Version => println!("abundio-server {}", env!("CARGO_PKG_VERSION")),
        Command::Connect { data_dir } => {
            let dir = data_dir.unwrap_or_else(|| {
                default_data_dir(&std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default())
            });
            #[cfg(unix)]
            if let Err(e) = serve::connect(&socket_path(&dir)) {
                eprintln!("abundio-server: {e}");
                std::process::exit(4);
            }
            #[cfg(not(unix))]
            {
                let _ = dir;
                eprintln!("abundio-server: connect is not available on this platform yet");
                std::process::exit(4);
            }
        }
        Command::Run { data_dir } => {
            init_log();
            let dir = data_dir.unwrap_or_else(|| {
                default_data_dir(&std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default())
            });
            if let Err(e) = run(dir) {
                log::error!("{e}");
                std::process::exit(3);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn reads_its_command_line() {
        assert_eq!(parse_args(&args(&[])), Ok(Command::Help));
        assert_eq!(parse_args(&args(&["version"])), Ok(Command::Version));
        assert_eq!(parse_args(&args(&["run"])), Ok(Command::Run { data_dir: None }));
        assert_eq!(parse_args(&args(&["connect"])), Ok(Command::Connect { data_dir: None }));
        assert_eq!(
            parse_args(&args(&["connect", "--data-dir", "/d"])),
            Ok(Command::Connect { data_dir: Some(PathBuf::from("/d")) })
        );
        assert_eq!(
            parse_args(&args(&["run", "--data-dir", "/srv/a"])),
            Ok(Command::Run { data_dir: Some(PathBuf::from("/srv/a")) })
        );
        assert!(parse_args(&args(&["run", "--data-dir"])).is_err());
        assert!(parse_args(&args(&["run", "--port", "1"])).is_err());
        assert!(parse_args(&args(&["serve"])).is_err());
    }

    #[test]
    fn is_the_apps_own_build() {
        // The release script bumps every crate: the handshake compares these.
        assert_eq!(env!("CARGO_PKG_VERSION"), abundio_core::host_protocol::VERSION);
    }

    #[test]
    fn keeps_its_data_apart_from_the_desktop_app() {
        assert_eq!(default_data_dir(Path::new("/home/u")), PathBuf::from("/home/u/.abundio-server/data"));
    }

    #[test]
    fn one_server_per_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = take_lock(dir.path()).unwrap();
        let second = take_lock(dir.path()).unwrap_err();
        assert!(second.contains("already running"), "{second}");
        drop(first);
        assert!(take_lock(dir.path()).is_ok());
    }
}

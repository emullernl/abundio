//! **abundio-server**: Abundio on a Host with no window (ADR-0062,
//! docs/plans/remote-hosts.md phase 6). It keeps a Profile's Workspaces,
//! PTYs and Agents running, with their status, layouts and Agent control,
//! whether or not a desktop Client is connected.
//!
//! This step starts the core services and waits: the database, the stores,
//! the PTY manager, the status scan and the hook server. Clients connect in
//! phase 7 (`abundio-server connect`, a framed protocol over SSH); until then
//! events have nowhere to go and Agent control answers that no Client is
//! connected.
//!
//! Usage: `abundio-server run [--data-dir DIR]`, `abundio-server version`.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use abundio_core::event_sink::{ClientId, EventSink, Events};
use abundio_core::events::AgentHookEvent;
use abundio_core::hook_server::{HookHost, HookServer};
use abundio_core::{
    app_paths, db_open, env_vars, layout_store, migrations, pane_facts, pty_manager, status_machine,
    status_store,
    workspace_store,
};
use serde_json::Value;

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run { data_dir: Option<PathBuf> },
    Version,
    Help,
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    match args.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => Ok(Command::Help),
        Some("version" | "--version" | "-V") => Ok(Command::Version),
        Some("run") => {
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
            Ok(Command::Run { data_dir })
        }
        Some(other) => Err(format!("unknown command {other:?}; try `abundio-server help`")),
    }
}

const HELP: &str = "abundio-server: Abundio on a Host with no window.

  abundio-server run [--data-dir DIR]   Run in the foreground (systemd, a LaunchAgent).
                                        Data goes in DIR, by default ~/.abundio-server/data.
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

// ── Where events go while no Client is connected ──

/// Events with no Client to receive them yet (phase 7 adds the connection).
struct NoClients;

impl EventSink for NoClients {
    fn broadcast_value(&self, event: &str, _payload: Value) {
        log::trace!("event {event} (no Client connected)");
    }
    fn to_client_value(&self, client: &ClientId, event: &str, _payload: Value) {
        log::trace!("event {event} for {} (no Client connected)", client.as_str());
    }
    fn pty_output(&self, _pty_id: &str, _data: &[u8]) {}
}

/// The hook server's view of the server.
struct ServerHookHost {
    ptys: Arc<pty_manager::PtyManager>,
    env: Arc<env_vars::EnvVarStore>,
    status: Arc<status_store::StatusStore>,
}

impl HookHost for ServerHookHost {
    /// The status is kept here, Window or not (phase 6d).
    fn hook_event(&self, pty_id: &str, event: AgentHookEvent) {
        log::debug!("hook {} from {} in {pty_id}", event.event, event.agent);
        abundio_core::hook_apply::apply(
            &self.status,
            pty_id,
            &event.agent,
            &event.event,
            &event.payload,
            abundio_core::hook_apply::now_ms(),
            &status_machine::StatusConfig::default(),
        );
    }
    fn ptys(&self) -> Option<&pty_manager::PtyManager> {
        Some(&self.ptys)
    }
    fn env_store(&self) -> Option<&env_vars::EnvVarStore> {
        Some(&self.env)
    }
    fn control_refuse_unknown(&self, request: tiny_http::Request) -> Option<tiny_http::Request> {
        let body = r#"{"error":{"code":"no_client","message":"no Abundio window is connected to this Host yet"}}"#;
        let _ = request.respond(tiny_http::Response::from_string(body).with_status_code(503));
        None
    }
    fn control_serve(&self, _request: tiny_http::Request) {}
}

// ── Running ──

/// Holds the data folder for this process: a second server on the same
/// folder would fight over its database and its PTYs.
fn take_lock(root: &Path) -> Result<File, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
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
    let _lock = take_lock(&data_dir)?;
    log::info!("abundio-server {} with data in {}", env!("CARGO_PKG_VERSION"), data_dir.display());

    let workspaces = workspace_store::WorkspaceStore::new(open_db()?);
    let env = Arc::new(env_vars::EnvVarStore::new(open_db()?));
    let ptys = Arc::new(pty_manager::PtyManager::new());
    let status = Arc::new(status_store::StatusStore::new());
    let _layouts = layout_store::LayoutStore::new();
    let _facts = pane_facts::PaneFactsStore::new();
    let events: Events = Arc::new(NoClients);
    {
        // A PTY's exit reaches its status here, Window or not (phase 6d).
        let status = status.clone();
        ptys.on_exit(Arc::new(move |pty, code| {
            let _ = status.exit_update(pty, code, &status_machine::StatusConfig::default());
        }));
    }
    status_store::start_ticker(status.clone(), events);

    let host = Arc::new(ServerHookHost { ptys: ptys.clone(), env, status: status.clone() });
    let hooks = HookServer::start(host)?;
    log::info!("hook server on 127.0.0.1:{}", hooks.port);
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
        assert_eq!(
            parse_args(&args(&["run", "--data-dir", "/srv/a"])),
            Ok(Command::Run { data_dir: Some(PathBuf::from("/srv/a")) })
        );
        assert!(parse_args(&args(&["run", "--data-dir"])).is_err());
        assert!(parse_args(&args(&["run", "--port", "1"])).is_err());
        assert!(parse_args(&args(&["serve"])).is_err());
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

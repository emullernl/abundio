use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;

use base64::Engine;
use crossbeam_channel::{self, Receiver, Sender};
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;
use crate::events::{PtyActivity, PtyOutput, PtyStatus};
use crate::process_monitor;
use crate::shell_env;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

/// Commands sent from the main thread to a PTY's dedicated thread.
enum PtyCommand {
    Write(Vec<u8>),
    Resize(u16, u16),
    Kill,
}

/// Metadata stored in the registry for each PTY.
struct PtyEntry {
    tx: Sender<PtyCommand>,
    #[allow(dead_code)]
    alive: Arc<AtomicBool>,
}

pub struct PtyManager {
    entries: DashMap<String, PtyEntry>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            entries: DashMap::new(),
        }
    }

    /// Spawn a new PTY in a dedicated OS thread.
    ///
    /// - `cwd`: working directory for the shell
    /// - `command`: optional command to run instead of the default shell
    /// - `cols`, `rows`: initial terminal size
    /// - `log_id`: optional stable identifier for the PTY output log file
    ///
    /// Returns the PTY ID.
    pub fn spawn(
        &self,
        app: AppHandle,
        cwd: &str,
        command: Option<&str>,
        cols: u16,
        rows: u16,
        log_id: Option<&str>,
        pty_id: Option<&str>,
    ) -> Result<String, AbundioError> {
        let pty_id = pty_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let pty_system = native_pty_system();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| AbundioError::Pty(e.to_string()))?;

        let shell = shell_env::default_shell();
        let shell_type = detect_shell_type(&shell);
        let integration_dir = shell_integration_dir();

        let mut cmd = if let Some(command) = command {
            let parts: Vec<&str> = command.split_whitespace().collect();
            let mut cmd = CommandBuilder::new(parts[0]);
            for arg in &parts[1..] {
                cmd.arg(arg);
            }
            cmd
        } else {
            let mut cmd = CommandBuilder::new(&shell);
            match shell_type {
                ShellType::Zsh => {
                    cmd.args(["-l", "-i"]);
                    // Redirect ZDOTDIR so zsh loads our wrapper .zshrc
                    let original_zdotdir =
                        std::env::var("ZDOTDIR").unwrap_or_default();
                    cmd.env("ABUNDIO_ORIGINAL_ZDOTDIR", &original_zdotdir);
                    let zdotdir_str = integration_dir.to_string_lossy().into_owned();
                    #[cfg(target_os = "windows")]
                    let zdotdir_str = zdotdir_str.replace('\\', "/");
                    cmd.env("ZDOTDIR", &zdotdir_str);
                }
                ShellType::Bash => {
                    // Use --rcfile to load our wrapper (not -l; --rcfile is ignored for login shells)
                    let rcfile = integration_dir.join(".bashrc");
                    let rcfile_str = rcfile.to_string_lossy().into_owned();
                    // Git Bash on Windows needs forward-slash paths
                    #[cfg(target_os = "windows")]
                    let rcfile_str = rcfile_str.replace('\\', "/");
                    cmd.args(["--rcfile", &rcfile_str, "-i"]);
                }
                ShellType::Other => {
                    #[cfg(not(target_os = "windows"))]
                    cmd.args(["-l", "-i"]);
                }
            }
            cmd
        };

        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "Abundio");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // Suppress zsh's partial-line EOL marker (%) so it doesn't appear in replayed scrollback logs
        cmd.env("PROMPT_EOL_MARK", "");

        if Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AbundioError::Pty(e.to_string()))?;

        // Drop slave — we only need the master
        drop(pair.slave);

        let (tx, rx): (Sender<PtyCommand>, Receiver<PtyCommand>) = crossbeam_channel::unbounded();
        let alive = Arc::new(AtomicBool::new(true));

        self.entries.insert(
            pty_id.clone(),
            PtyEntry {
                tx,
                alive: alive.clone(),
            },
        );

        // Open log file for PTY output persistence
        let log_file = log_id.and_then(|id| {
            let log_dir = Self::log_dir();
            fs::create_dir_all(&log_dir).ok()?;
            let log_path = log_dir.join(format!("{}.log", id));
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok()
                .map(|f| (f, log_path))
        });

        let id_clone = pty_id.clone();
        let master = pair.master;

        thread::spawn(move || {
            pty_thread(id_clone, master, child, rx, alive, app, log_file, shell_type);
        });

        Ok(pty_id)
    }

    pub fn write(&self, pty_id: &str, data: Vec<u8>) -> Result<(), AbundioError> {
        let entry = self
            .entries
            .get(pty_id)
            .ok_or_else(|| AbundioError::NotFound(format!("PTY not found: {}", pty_id)))?;
        entry
            .tx
            .send(PtyCommand::Write(data))
            .map_err(|e| AbundioError::Channel(e.to_string()))
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<(), AbundioError> {
        let entry = self
            .entries
            .get(pty_id)
            .ok_or_else(|| AbundioError::NotFound(format!("PTY not found: {}", pty_id)))?;
        entry
            .tx
            .send(PtyCommand::Resize(cols, rows))
            .map_err(|e| AbundioError::Channel(e.to_string()))
    }

    pub fn kill(&self, pty_id: &str) -> Result<(), AbundioError> {
        if let Some(entry) = self.entries.get(pty_id) {
            let _ = entry.tx.send(PtyCommand::Kill);
        }
        self.entries.remove(pty_id);
        Ok(())
    }

    fn log_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| Path::new("~").to_path_buf())
            .join("abundio")
            .join("pty-logs")
    }

    /// Read a PTY output log file, returning its contents as base64.
    pub fn read_log(log_id: &str) -> Result<Option<String>, AbundioError> {
        let log_path = Self::log_dir().join(format!("{}.log", log_id));
        if !log_path.exists() {
            return Ok(None);
        }
        let data = fs::read(&log_path)?;
        if data.is_empty() {
            return Ok(None);
        }
        let engine = base64::engine::general_purpose::STANDARD;
        Ok(Some(engine.encode(&data)))
    }

    /// Write a serialized terminal snapshot (from xterm SerializeAddon).
    pub fn write_snapshot(pane_id: &str, data: &str) -> Result<(), AbundioError> {
        let dir = Self::log_dir();
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.snapshot", pane_id));
        fs::write(&path, data.as_bytes())?;
        Ok(())
    }

    /// Read a terminal snapshot, returning its contents as a string.
    pub fn read_snapshot(pane_id: &str) -> Result<Option<String>, AbundioError> {
        let path = Self::log_dir().join(format!("{}.snapshot", pane_id));
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read_to_string(&path)?;
        if data.is_empty() {
            return Ok(None);
        }
        Ok(Some(data))
    }

    /// Delete a PTY output log file and its snapshot.
    pub fn delete_log(log_id: &str) -> Result<(), AbundioError> {
        let log_dir = Self::log_dir();
        let log_path = log_dir.join(format!("{}.log", log_id));
        if log_path.exists() {
            fs::remove_file(&log_path)?;
        }
        let snapshot_path = log_dir.join(format!("{}.snapshot", log_id));
        if snapshot_path.exists() {
            fs::remove_file(&snapshot_path)?;
        }
        Ok(())
    }

    /// Remove log and snapshot files that don't belong to any known pane ID.
    pub fn cleanup_stale_logs(valid_pane_ids: &[String]) -> Result<(), AbundioError> {
        let log_dir = Self::log_dir();
        if !log_dir.exists() {
            return Ok(());
        }
        let valid: HashSet<&str> = valid_pane_ids.iter().map(|s| s.as_str()).collect();
        for entry in fs::read_dir(&log_dir)? {
            let entry = entry?;
            let path = entry.path();
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !valid.contains(stem) {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }
}

/// Shell type detected from the binary name.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ShellType {
    Zsh,
    Bash,
    Other,
}

fn detect_shell_type(shell: &str) -> ShellType {
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(shell);
    if base.contains("zsh") {
        ShellType::Zsh
    } else if base.contains("bash") {
        ShellType::Bash
    } else {
        ShellType::Other
    }
}

/// Returns the directory containing shell integration startup files.
/// Creates the files on first call per process lifetime. The hooks are loaded
/// via ZDOTDIR (zsh) or --rcfile (bash) so they never appear in terminal output
/// or history.
fn shell_integration_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        write_shell_integration_files()
    }).clone()
}

fn write_shell_integration_files() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| Path::new("~").to_path_buf())
        .join("abundio")
        .join("shell-integration");
    let _ = fs::create_dir_all(&dir);

    // zsh: wrapper .zshrc that sources user config then adds hooks
    let zshrc = dir.join(".zshrc");
    let _ = fs::write(
        &zshrc,
        r#"# Abundio shell integration — loaded via ZDOTDIR
# Source the user's real zsh config
if [ -n "$ABUNDIO_ORIGINAL_ZDOTDIR" ] && [ -f "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR="$ABUNDIO_ORIGINAL_ZDOTDIR"
  source "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  ZDOTDIR="$HOME"
  source "$HOME/.zshrc"
fi
# Hooks
__abundio_preexec() { printf '\e]7770;command_start\a' }
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?" }
precmd_functions+=(__abundio_precmd)
preexec_functions+=(__abundio_preexec)
"#,
    );

    // Also create .zshenv to source the user's .zshenv
    let zshenv = dir.join(".zshenv");
    let _ = fs::write(
        &zshenv,
        r#"# Abundio: forward to user's real .zshenv
if [ -n "$ABUNDIO_ORIGINAL_ZDOTDIR" ] && [ -f "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshenv" ]; then
  source "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshenv"
elif [ -f "$HOME/.zshenv" ]; then
  source "$HOME/.zshenv"
fi
"#,
    );

    // bash: wrapper rcfile that sources user config then adds hooks
    let bashrc = dir.join(".bashrc");

    // On Windows (Git Bash / MSYS2), skip /etc/profile and /etc/bash.bashrc —
    // these are MSYS2 system scripts that send terminal reset sequences which
    // wipe restored scrollback. Git Bash already runs MSYS2 init before --rcfile.
    #[cfg(target_os = "windows")]
    let bashrc_content = r#"# Abundio shell integration — loaded via --rcfile
if [ -f ~/.bash_profile ]; then
  source ~/.bash_profile
elif [ -f ~/.bash_login ]; then
  source ~/.bash_login
elif [ -f ~/.profile ]; then
  source ~/.profile
fi
# Source the user's real bash config
[ -f ~/.bashrc ] && source ~/.bashrc
# Hooks
__abundio_preexec() { printf '\e]7770;command_start\a'; }
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?"; }
trap '__abundio_preexec' DEBUG
PROMPT_COMMAND="__abundio_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

    #[cfg(not(target_os = "windows"))]
    let bashrc_content = r#"# Abundio shell integration — loaded via --rcfile
# Source login shell config files for parity (--rcfile replaces -l)
[ -f /etc/profile ] && source /etc/profile
if [ -f ~/.bash_profile ]; then
  source ~/.bash_profile
elif [ -f ~/.bash_login ]; then
  source ~/.bash_login
elif [ -f ~/.profile ]; then
  source ~/.profile
fi
# Source the user's real bash config
[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc
[ -f ~/.bashrc ] && source ~/.bashrc
# Hooks
__abundio_preexec() { printf '\e]7770;command_start\a'; }
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?"; }
trap '__abundio_preexec' DEBUG
PROMPT_COMMAND="__abundio_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

    let _ = fs::write(&bashrc, bashrc_content);

    dir
}

/// Runs on a dedicated OS thread. Owns the master PTY and child process.
fn pty_thread(
    pty_id: String,
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    rx: Receiver<PtyCommand>,
    alive: Arc<AtomicBool>,
    app: AppHandle,
    log_file: Option<(File, PathBuf)>,
    shell_type: ShellType,
) {
    let mut writer = master.take_writer().unwrap();
    let mut reader = master.try_clone_reader().unwrap();

    // Get shell PID for child process monitoring
    let shell_pid = child.process_id();
    if shell_pid.is_none() {
        eprintln!("[pty_thread] WARNING: shell process_id() returned None for pty {}", pty_id);
    }
    let mut command_running = false;
    let mut last_fg_processes: Vec<String> = Vec::new();

    // Spawn a sub-thread for reading PTY output → emitting events
    let read_pty_id = pty_id.clone();
    let read_alive = alive.clone();
    let read_app = app.clone();

    let read_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let engine = base64::engine::general_purpose::STANDARD;
        let mut log = log_file;

        loop {
            if !read_alive.load(Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    // Append raw output to log file for persistence
                    if let Some((ref mut file, ref path)) = log {
                        let _ = file.write_all(&buf[..n]);
                        // Truncate if log exceeds max size
                        if let Ok(meta) = file.metadata() {
                            if meta.len() > MAX_LOG_SIZE {
                                truncate_log_file(path, MAX_LOG_SIZE / 2);
                                // Reopen in append mode after truncation
                                if let Ok(f) = OpenOptions::new().append(true).open(path) {
                                    *file = f;
                                }
                            }
                        }
                    }

                    let encoded = engine.encode(&buf[..n]);
                    let event_name = format!("pty-output-{}", read_pty_id);
                    let _ = read_app.emit(&event_name, PtyOutput { data: encoded });
                }
                Err(_) => break,
            }
        }
    });

    // Main loop: process commands from the channel
    loop {
        // Check if child has exited
        if let Ok(Some(status)) = child.try_wait() {
            alive.store(false, Ordering::Relaxed);
            let code = Some(status.exit_code());
            let event_name = format!("pty-status-{}", pty_id);
            let _ = app.emit(&event_name, PtyStatus::Exited { code });
            break;
        }

        // Poll for child processes of the shell.
        if let Some(pid) = shell_pid {
            let child_names = process_monitor::get_child_process_names(pid);
            let has_children = !child_names.is_empty();

            // CommandStarted/CommandFinished: only for shells without OSC integration
            // (zsh/bash use OSC 7770 sequences instead, so polling would race).
            if shell_type == ShellType::Other {
                if has_children && !command_running {
                    command_running = true;
                    let event_name = format!("pty-activity-{}", pty_id);
                    let _ = app.emit(&event_name, PtyActivity::CommandStarted);
                } else if !has_children && command_running {
                    command_running = false;
                    let event_name = format!("pty-activity-{}", pty_id);
                    let _ = app.emit(&event_name, PtyActivity::CommandFinished);
                }
            }

            // ForegroundProcess detection: emit for all shell types so the
            // frontend can toggle agent/shell detection mode.
            // On Windows, child_names may include processes from the full
            // snapshot (MSYS2 reparenting workaround), so we emit an event
            // for every NEW name and let the frontend filter by agent list.
            if child_names != last_fg_processes {
                let event_name = format!("pty-activity-{}", pty_id);
                for name in &child_names {
                    if !last_fg_processes.contains(name) {
                        let _ = app.emit(&event_name, PtyActivity::ForegroundProcess { name: name.clone() });
                    }
                }
                // Emit exit for each name that disappeared — the frontend
                // only acts on this if the name was an agent.
                for name in &last_fg_processes {
                    if !child_names.contains(name) {
                        let _ = app.emit(&event_name, PtyActivity::ForegroundProcessExited { name: name.clone() });
                    }
                }
                last_fg_processes = child_names;
            }
        }

        // Non-blocking receive with a short timeout to allow checking child status
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(PtyCommand::Write(data)) => {
                let _ = writer.write_all(&data);
            }
            Ok(PtyCommand::Resize(cols, rows)) => {
                let _ = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            Ok(PtyCommand::Kill) => {
                alive.store(false, Ordering::Relaxed);
                let _ = child.kill();
                let event_name = format!("pty-status-{}", pty_id);
                let _ = app.emit(&event_name, PtyStatus::Exited { code: None });
                break;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // Continue loop — check child status again
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // Channel closed, clean up
                alive.store(false, Ordering::Relaxed);
                let _ = child.kill();
                break;
            }
        }
    }

    let _ = read_thread.join();
}

/// Truncate a log file by keeping only the last `keep_bytes` bytes.
fn truncate_log_file(path: &Path, keep_bytes: u64) {
    let Ok(data) = fs::read(path) else { return };
    let len = data.len() as u64;
    if len <= keep_bytes {
        return;
    }
    let start = (len - keep_bytes) as usize;
    if let Ok(mut file) = File::create(path) {
        let _ = file.write_all(&data[start..]);
    }
}

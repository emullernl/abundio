use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
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
        shell: Option<&str>,
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

        let shell = match shell {
            Some(s) if Path::new(s).exists() => s.to_string(),
            Some(s) => {
                let fallback = shell_env::default_shell();
                let _ = app.emit(
                    &format!("pty-status-{}", pty_id),
                    PtyStatus::ShellNotFound {
                        configured: s.to_string(),
                        fallback: fallback.clone(),
                    },
                );
                fallback
            }
            None => shell_env::default_shell(),
        };
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
                ShellType::PowerShell => {
                    let init_script = integration_dir.join("abundio_init.ps1");
                    let init_str = init_script.to_string_lossy().into_owned();
                    #[cfg(target_os = "windows")]
                    let init_str = init_str.replace('\\', "/");
                    // Bypass execution policy for this process only (same as VS Code terminal)
                    // so our integration script loads regardless of system policy.
                    cmd.args(["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", &init_str]);
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

        // Per-pane shell history: point the shell at a history file keyed by log_id
        // so each terminal has isolated Up-arrow recall. The wrapper rc files still
        // dual-write each command to the user's real history file.
        if let Some(id) = log_id {
            let hist_dir = Self::history_dir();
            if fs::create_dir_all(&hist_dir).is_ok() {
                let hist_path = hist_dir.join(format!("{}.history", id));
                cmd.env("ABUNDIO_HISTFILE", hist_path.to_string_lossy().as_ref());
            }
        }

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

    fn history_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| Path::new("~").to_path_buf())
            .join("abundio")
            .join("shell-history")
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
        let history_path = Self::history_dir().join(format!("{}.history", log_id));
        if history_path.exists() {
            fs::remove_file(&history_path)?;
        }
        Ok(())
    }

    /// Remove log and snapshot files that don't belong to any known pane ID.
    pub fn cleanup_stale_logs(valid_pane_ids: &[String]) -> Result<(), AbundioError> {
        let valid: HashSet<&str> = valid_pane_ids.iter().map(|s| s.as_str()).collect();
        for dir in [Self::log_dir(), Self::history_dir()] {
            if !dir.exists() {
                continue;
            }
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if !valid.contains(stem) {
                        let _ = fs::remove_file(&path);
                    }
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
    PowerShell,
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
    } else if base.contains("pwsh") || base.contains("powershell") {
        ShellType::PowerShell
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
# Per-pane history: isolate Up-arrow recall to this terminal. Runs after
# user config so HISTSIZE/SAVEHIST are preserved.
if [ -n "$ABUNDIO_HISTFILE" ]; then
  # Capture the user's real HISTFILE before we override it, so we can
  # dual-write each command into the global history too.
  __abundio_global_histfile="${HISTFILE:-$HOME/.zsh_history}"
  HISTFILE="$ABUNDIO_HISTFILE"
  [ -f "$HISTFILE" ] && fc -R "$HISTFILE" 2>/dev/null
  # Dual-write: every accepted command is appended to the user's global
  # history file in addition to this pane's isolated file.
  zshaddhistory() {
    print -r -- "${1%$'\n'}" >>| "$__abundio_global_histfile"
    return 0
  }
fi
# Hooks
__abundio_preexec() { printf '\e]7770;command_start;%s\a' "${1//$'\a'/ }" }
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

    // The frontend now parks scrollback until after shell startup finishes
    // (see terminalManager.ts flushStartupBuffer), so reset sequences from
    // MSYS2 /etc/profile / /etc/bash.bashrc can no longer clobber restored
    // scrollback. Use a single unified bashrc across all platforms.
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
# Per-pane history
if [ -n "$ABUNDIO_HISTFILE" ]; then
  __abundio_global_histfile="${HISTFILE:-$HOME/.bash_history}"
  HISTFILE="$ABUNDIO_HISTFILE"
  history -c
  [ -f "$HISTFILE" ] && history -r
  __abundio_last_histcmd=0
  __abundio_dual_write() {
    # Append any new command since last prompt to the user's global history.
    local last_id cmd
    last_id=$(HISTTIMEFORMAT='' history 1 | awk '{print $1}')
    if [ -n "$last_id" ] && [ "$last_id" != "$__abundio_last_histcmd" ]; then
      cmd=$(HISTTIMEFORMAT='' history 1)
      cmd="${cmd#*[0-9]  }"
      printf '%s\n' "$cmd" >> "$__abundio_global_histfile"
      __abundio_last_histcmd="$last_id"
    fi
  }
  PROMPT_COMMAND="__abundio_dual_write${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
# Hooks
__abundio_preexec() {
  [ "$BASH_COMMAND" = "__abundio_precmd" ] && return
  printf '\e]7770;command_start;%s\a' "$BASH_COMMAND"
}
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?"; }
trap '__abundio_preexec' DEBUG
PROMPT_COMMAND="__abundio_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

    let _ = fs::write(&bashrc, bashrc_content);

    // PowerShell: wrapper init script that sources user profile then adds hooks
    // Uses [char]0x1b (ESC) and [char]0x07 (BEL) for PS 5.1 compatibility
    // (`e and `a require PS 6+).
    let ps1 = dir.join("abundio_init.ps1");
    let _ = fs::write(
        &ps1,
        r#"# Abundio shell integration for PowerShell — loaded via -NoProfile -File
# Source the user's profile first
if (Test-Path $PROFILE) { . $PROFILE }

# ESC and BEL characters for OSC sequences (compatible with PS 5.1+)
$Global:__AbundioESC = [char]0x1b
$Global:__AbundioBEL = [char]0x07
$Global:__AbundioLastHistoryId = -1

# Stash the user's prompt (from profile or default) so we can wrap it
$Global:__AbundioOriginalPrompt = $function:prompt

function Global:prompt {
    $lastExit = $LASTEXITCODE
    if ($null -eq $lastExit) { $lastExit = 0 }
    $lastEntry = Get-History -Count 1 -ErrorAction SilentlyContinue
    # Emit command_end for the previous command (if a new command ran)
    if ($Global:__AbundioLastHistoryId -ne -1 -and $lastEntry -and $lastEntry.Id -ne $Global:__AbundioLastHistoryId) {
        $Host.UI.Write("$Global:__AbundioESC]7770;command_end;$lastExit$Global:__AbundioBEL")
    }
    if ($lastEntry) { $Global:__AbundioLastHistoryId = $lastEntry.Id }
    # Call the original prompt function
    if ($Global:__AbundioOriginalPrompt) {
        & $Global:__AbundioOriginalPrompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }
}

# Hook Enter key via PSReadLine to emit command_start (preexec equivalent)
if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        $line = $null
        $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        if ($line.Trim().Length -gt 0) {
            $escaped = $line -replace [char]0x07, ' '
            $Host.UI.Write("$Global:__AbundioESC]7770;command_start;$escaped$Global:__AbundioBEL")
        }
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# Per-pane history: isolate PSReadLine history to this terminal, and
# dual-write each accepted line into the user's original global file.
if ($env:ABUNDIO_HISTFILE -and (Get-Module -Name PSReadLine)) {
    $Global:__AbundioGlobalHistPath = (Get-PSReadLineOption).HistorySavePath
    Set-PSReadLineOption -HistorySavePath $env:ABUNDIO_HISTFILE
    Set-PSReadLineOption -AddToHistoryHandler {
        param($line)
        if ($line -and $Global:__AbundioGlobalHistPath) {
            try {
                Add-Content -LiteralPath $Global:__AbundioGlobalHistPath -Value $line -ErrorAction SilentlyContinue
            } catch {}
        }
        return [Microsoft.PowerShell.AddToHistoryOption]::MemoryAndFile
    }
}
"#,
    );

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

    // For ShellType::Other, poll child processes to emit CommandStarted/CommandFinished
    // (zsh/bash get these via OSC 7770 shell integration hooks instead).
    let shell_pid = if shell_type == ShellType::Other {
        let pid = child.process_id();
        if pid.is_none() {
            eprintln!("[pty_thread] WARNING: shell process_id() returned None for pty {}", pty_id);
        }
        pid
    } else {
        None
    };
    let mut command_running = false;

    // Spawn a sub-thread for reading PTY output → emitting events
    let read_pty_id = pty_id.clone();
    let read_alive = alive.clone();
    let read_app = app.clone();

    // Output coalescing: a dedicated reader thread sends raw chunks through a
    // bounded channel.  The coalescing loop drains all immediately-available
    // chunks before base64-encoding and emitting a single batched event.
    // During burst output this collapses many small reads into one IPC event;
    // during interactive use the try_recv drain returns immediately so latency
    // is unaffected.
    let read_thread = thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut log = log_file;
        let event_name = format!("pty-output-{}", read_pty_id);

        // Bounded channel: 32 slots × 4 KB = 128 KB max buffered before
        // back-pressure slows the reader — prevents unbounded memory growth.
        let (chunk_tx, chunk_rx) = crossbeam_channel::bounded::<Vec<u8>>(32);

        // Inner thread: blocking reads from PTY master fd
        let inner_alive = read_alive.clone();
        let inner = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                if !inner_alive.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        const MAX_ACCUM: usize = 16 * 1024; // 16 KB — rAF batching in the frontend handles burst coalescing
        let mut accum = Vec::with_capacity(MAX_ACCUM);

        loop {
            if !read_alive.load(Ordering::Relaxed) {
                break;
            }

            // Block until at least one chunk arrives (or channel closes)
            match chunk_rx.recv() {
                Ok(chunk) => {
                    append_to_log(&mut log, &chunk);
                    accum.extend_from_slice(&chunk);
                }
                Err(_) => break,
            }

            // Drain all immediately-available chunks without blocking
            while accum.len() < MAX_ACCUM {
                match chunk_rx.try_recv() {
                    Ok(chunk) => {
                        append_to_log(&mut log, &chunk);
                        accum.extend_from_slice(&chunk);
                    }
                    Err(_) => break,
                }
            }

            // Emit the coalesced batch as a single event
            let encoded = engine.encode(&accum);
            let _ = read_app.emit(&event_name, PtyOutput { data: encoded });
            accum.clear();
        }

        // Flush any remaining data after channel close
        for chunk in chunk_rx.try_iter() {
            append_to_log(&mut log, &chunk);
            accum.extend_from_slice(&chunk);
        }
        if !accum.is_empty() {
            let encoded = engine.encode(&accum);
            let _ = read_app.emit(&event_name, PtyOutput { data: encoded });
        }

        let _ = inner.join();
    });

    // Main loop: process commands from the channel
    let mut last_process_check = Instant::now();
    let poll_interval = Duration::from_millis(200);

    loop {
        // Check if child has exited
        if let Ok(Some(status)) = child.try_wait() {
            alive.store(false, Ordering::Relaxed);
            let code = Some(status.exit_code());
            let event_name = format!("pty-status-{}", pty_id);
            let _ = app.emit(&event_name, PtyStatus::Exited { code });
            break;
        }

        // For ShellType::Other: lightweight child-process polling for
        // CommandStarted/CommandFinished (no name resolution needed).
        if let Some(pid) = shell_pid {
            if last_process_check.elapsed() >= poll_interval {
                last_process_check = Instant::now();
                let has_children = process_monitor::has_child_processes(pid);
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
        }

        let recv_timeout = if shell_pid.is_some() {
            poll_interval
                .checked_sub(last_process_check.elapsed())
                .unwrap_or(Duration::from_millis(10))
                .min(Duration::from_millis(100))
        } else {
            Duration::from_millis(100)
        };

        match rx.recv_timeout(recv_timeout) {
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

/// Append raw bytes to the log file and truncate if it exceeds the limit.
fn append_to_log(log: &mut Option<(File, PathBuf)>, data: &[u8]) {
    if let Some((ref mut file, ref path)) = log {
        let _ = file.write_all(data);
        if let Ok(meta) = file.metadata() {
            if meta.len() > MAX_LOG_SIZE {
                truncate_log_file(path, MAX_LOG_SIZE / 2);
                if let Ok(f) = OpenOptions::new().append(true).open(path) {
                    *file = f;
                }
            }
        }
    }
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

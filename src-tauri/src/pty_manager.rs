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
use tauri::{AppHandle, Emitter, Manager};

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

/// Which Workspace a live PTY belongs to.
///
/// Recorded at spawn so the `abundio-env` helper can resolve a Bundle from
/// nothing but `ABUNDIO_PTY_ID`. That is what stops a pane asking for another
/// Workspace's variables: the Workspace is derived from the pty id, never taken
/// from the request body. See `hook_server.rs`.
#[derive(Clone, Debug)]
pub struct SpawnContext {
    pub workspace_id: String,
    /// Main-worktree Workspace this pane inherits from, if any.
    pub inherit_from: Option<String>,
}

pub struct PtyManager {
    entries: DashMap<String, PtyEntry>,
    spawn_contexts: DashMap<String, SpawnContext>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            entries: DashMap::new(),
            spawn_contexts: DashMap::new(),
        }
    }

    /// The Workspace a live PTY belongs to, or `None` if the pty id is unknown
    /// (already exited, or spawned before a workspace id was available).
    pub fn spawn_context(&self, pty_id: &str) -> Option<SpawnContext> {
        self.spawn_contexts.get(pty_id).map(|e| e.clone())
    }

    /// Spawn a new PTY in a dedicated OS thread.
    ///
    /// - `cwd`: working directory for the shell
    /// - `command`: optional command to run instead of the default shell
    /// - `cols`, `rows`: initial terminal size
    /// - `log_id`: optional stable identifier for the PTY output log file
    /// - `workspace_id` / `inherit_from_workspace_id`: which Workspace's
    ///   injected Bundle to place in the child's environment. The second is the
    ///   main-worktree Workspace for a linked worktree; worktree grouping is
    ///   derived in the frontend and is not recomputed here.
    ///
    /// Returns the PTY ID.
    #[allow(clippy::too_many_arguments)]
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
        workspace_name: Option<&str>,
        window_label: Option<&str>,
        workspace_id: Option<&str>,
        inherit_from_workspace_id: Option<&str>,
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
                    // Our wrapper rcfile sources /etc/profile for login-shell
                    // parity. On Git Bash (MSYS2), /etc/profile does `cd "$HOME"`
                    // unless CHERE_INVOKING is set — which would clobber the spawn
                    // cwd and land every new terminal in the user's home folder
                    // instead of the workspace folder.
                    #[cfg(target_os = "windows")]
                    cmd.env("CHERE_INVOKING", "1");
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
        // Where the wrapper rc files and the `abundio-env` helper live. The
        // wrappers prepend this to PATH after the user's rc so `abundio-env` is
        // callable even if the rc rebuilds PATH from scratch.
        cmd.env(
            "ABUNDIO_INTEGRATION_DIR",
            integration_dir.to_string_lossy().as_ref(),
        );
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // Suppress zsh's partial-line EOL marker (%) so it doesn't appear in replayed scrollback logs
        cmd.env("PROMPT_EOL_MARK", "");

        // Agent hook correlation: the agent and its hook commands inherit these,
        // letting the abundio-hook relay attribute hook events to this PTY.
        if let Some(hook_server) = app.try_state::<crate::hook_server::HookServer>() {
            cmd.env("ABUNDIO_PTY_ID", &pty_id);
            cmd.env("ABUNDIO_HOOK_PORT", hook_server.port.to_string());
            cmd.env("ABUNDIO_HOOK_TOKEN", &hook_server.token);
            // Debug context for the hook server's log — these go out as request
            // headers (see RELAY_SH / RELAY_PS1). Captured at spawn time, so a
            // workspace rename after launch will not update them.
            cmd.env("ABUNDIO_WORKSPACE_NAME", workspace_name.unwrap_or(""));
            cmd.env("ABUNDIO_WINDOW_LABEL", window_label.unwrap_or(""));
        }

        // ── Workspace environment variables (injected Bundle) ──
        //
        // This must NEVER block the spawn. A locked or denied credential store,
        // or a row that cannot be decrypted, degrades to an empty set plus an
        // event the UI turns into a banner — the terminal still opens.
        let injected: Vec<(String, String)> = match (
            workspace_id,
            app.try_state::<crate::env_vars::EnvVarStore>(),
        ) {
            // Probe for rows BEFORE asking for the key. Touching the credential
            // store here would pop a Keychain prompt on the very first terminal
            // for users who never use this feature — and mint a key for them.
            (Some(ws), Some(store))
                if store
                    .has_injected_vars(ws, inherit_from_workspace_id)
                    .unwrap_or(false) =>
            {
                match crate::env_crypto::master_key() {
                    Ok(key) => store
                        .resolve_for_spawn(&key, ws, inherit_from_workspace_id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(name, value)| (name, value.to_string()))
                        .collect(),
                    Err(e) => {
                        log::warn!("[pty] workspace environment unavailable for {ws}: {e}");
                        let _ = app.emit(
                            "env-vars-unavailable",
                            serde_json::json!({ "workspaceId": ws, "reason": e.to_string() }),
                        );
                        Vec::new()
                    }
                }
            }
            _ => Vec::new(),
        };

        // Only the three wrapper scripts consume (and unset) the shadow copies.
        let has_wrapper = command.is_none()
            && matches!(
                shell_type,
                ShellType::Zsh | ShellType::Bash | ShellType::PowerShell
            );
        let (pairs, keys_manifest, skipped) = build_env_injection(
            &injected,
            crate::env_crypto::MAX_INJECTED_BYTES,
            has_wrapper,
        );
        for (name, value) in &pairs {
            cmd.env(name, value);
        }
        if !keys_manifest.is_empty() {
            cmd.env("ABUNDIO_ENV_KEYS", &keys_manifest);
        }
        if !skipped.is_empty() {
            log::warn!(
                "[pty] dropped {} workspace environment variable(s) over the {} byte budget: {}",
                skipped.len(),
                crate::env_crypto::MAX_INJECTED_BYTES,
                skipped.join(", ")
            );
        }

        if let Some(ws) = workspace_id {
            self.spawn_contexts.insert(
                pty_id.clone(),
                SpawnContext {
                    workspace_id: ws.to_string(),
                    inherit_from: inherit_from_workspace_id.map(|s| s.to_string()),
                },
            );
        }

        // A stamped cwd may arrive in Git Bash's MSYS form (`/c/Users/…`), which
        // Path can't validate on Windows; convert it to native form first.
        #[cfg(target_os = "windows")]
        let cwd = &msys_to_windows_path(cwd);
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
        self.spawn_contexts.remove(pty_id);
        Ok(())
    }

    fn log_dir() -> PathBuf {
        // Epoch-scoped: pane ids are carried over when a new epoch imports the
        // previous database, so a shared directory would have two builds
        // interleaving writes into the same `<paneId>.log`.
        crate::app_paths::pty_logs_dir()
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

/// Build the environment pairs for a Workspace's injected Bundle, plus the
/// `ABUNDIO_ENV_KEYS` manifest.
///
/// Each variable is emitted TWICE:
///  - under its own name, so shells with no Abundio wrapper rc (`ShellType::Other`,
///    and `command`-mode spawns) still receive it, and
///  - as `ABUNDIO_ENV__<NAME>`, the shadow the wrapper rc re-exports AFTER
///    sourcing the user's rc — that is what makes a workspace variable win over
///    an `export` in `.zshrc`.
///
/// Variable names are validated as shell identifiers upstream, so they can never
/// contain whitespace; that is what makes the space-separated manifest
/// unambiguous, and `ABUNDIO_` is reserved so the shadow prefix cannot collide.
///
/// Truncates at `budget_bytes` and reports what was dropped. This is not
/// cosmetic: on Windows the whole environment block is capped at 32,767
/// characters and `CreateProcess` FAILS on overflow, which would kill the pane.
/// `emit_shadow` is false for shells Abundio writes no wrapper rc for
/// (`ShellType::Other`, and `command`-mode spawns). The shadow exists only so
/// the wrapper can re-export after the user's rc; with no wrapper it would
/// never be consumed, and `ABUNDIO_ENV__*` plus `ABUNDIO_ENV_KEYS` would linger
/// in the environment of that shell and every child — doubling the footprint in
/// `env` output and crash dumps, and handing a reader the list of managed names.
pub(crate) fn build_env_injection(
    vars: &[(String, String)],
    budget_bytes: usize,
    emit_shadow: bool,
) -> (Vec<(String, String)>, String, Vec<String>) {
    let shadow_prefix = crate::env_crypto::SHADOW_PREFIX;

    let mut pairs: Vec<(String, String)> = Vec::with_capacity(vars.len() * 2);
    let mut names: Vec<String> = Vec::with_capacity(vars.len());
    let mut skipped: Vec<String> = Vec::new();
    let mut used = 0usize;

    for (name, value) in vars {
        let cost = if emit_shadow {
            crate::env_crypto::injection_cost(name.len(), value.len())
        } else {
            name.len() + value.len() + 2
        };
        if used + cost > budget_bytes {
            skipped.push(name.clone());
            continue;
        }
        used += cost;
        pairs.push((name.clone(), value.clone()));
        if emit_shadow {
            pairs.push((format!("{shadow_prefix}{name}"), value.clone()));
            names.push(name.clone());
        }
    }

    (pairs, names.join(" "), skipped)
}

/// Convert a Git Bash / MSYS path to its native Windows form. Pure string
/// transform; non-MSYS shapes pass through unchanged. Applied only on Windows,
/// where a leading `/c/` is unambiguously an MSYS drive path (a native path is
/// `C:\…` / `C:/…`); on Unix `/c/…` is a real path and must not be rewritten.
///   `/c/Users/x`     -> `c:/Users/x`
///   `/c`             -> `c:`
///   `//server/share` -> `\\server\share`   (UNC)
///   `/usr/bin`       -> `/usr/bin`          (not a single-letter drive segment)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn msys_to_windows_path(cwd: &str) -> String {
    if let Some(rest) = cwd.strip_prefix("//") {
        return format!("\\\\{}", rest.replace('/', "\\"));
    }
    let b = cwd.as_bytes();
    if b.len() >= 2
        && b[0] == b'/'
        && b[1].is_ascii_alphabetic()
        && (cwd.len() == 2 || b[2] == b'/')
    {
        // "/c" -> "c:", "/c/x" -> "c:/x"
        return format!("{}:{}", &cwd[1..2], &cwd[2..]);
    }
    cwd.to_string()
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

/// The re-export block shared in spirit by all three wrapper scripts.
///
/// PRECEDENCE IS THE WHOLE POINT: this must run AFTER the user's rc has been
/// sourced. `cmd.env` at spawn happens before the shell starts, so an `export`
/// in `.zshrc` would otherwise silently win over a Workspace variable. Restoring
/// from the `ABUNDIO_ENV__` shadows here makes the Workspace value final.
///
/// There is deliberately NO `eval` anywhere: values are arbitrary user data
/// including newlines and quotes, and `eval` would turn a stored certificate
/// into a code-execution vector. zsh uses `${(P)name}` indirect expansion, bash
/// uses `${!name}` + `printf -v`, PowerShell uses the Environment API.
const ZSHRC_BODY: &str = r#"# Abundio shell integration — loaded via ZDOTDIR
# Source the user's real zsh config
if [ -n "$ABUNDIO_ORIGINAL_ZDOTDIR" ] && [ -f "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR="$ABUNDIO_ORIGINAL_ZDOTDIR"
  source "$ABUNDIO_ORIGINAL_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  ZDOTDIR="$HOME"
  source "$HOME/.zshrc"
fi
# Re-apply this Workspace's environment variables AFTER the user's rc, so a
# workspace value deterministically beats an `export` in .zshrc. Values never
# appear in terminal output or shell history — this file is loaded via ZDOTDIR.
if [ -n "$ABUNDIO_ENV_KEYS" ]; then
  for __abundio_k in ${=ABUNDIO_ENV_KEYS}; do
    __abundio_s="ABUNDIO_ENV__${__abundio_k}"
    export "${__abundio_k}=${(P)__abundio_s}"
    unset "$__abundio_s"
  done
  unset __abundio_k __abundio_s ABUNDIO_ENV_KEYS
fi
# Make `abundio-env` reachable for on-demand Bundles. Appended after the user's
# rc so a PATH rebuild in .zshrc cannot drop it.
case ":$PATH:" in
  *":$ABUNDIO_INTEGRATION_DIR:"*) ;;
  *) [ -n "$ABUNDIO_INTEGRATION_DIR" ] && PATH="$ABUNDIO_INTEGRATION_DIR:$PATH" && export PATH ;;
esac
# Hooks
__abundio_preexec() { printf '\e]7770;command_start;%s\a' "${1//$'\a'/ }" }
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?"; printf '\e]7770;cwd;%s\a' "$PWD" }
precmd_functions+=(__abundio_precmd)
preexec_functions+=(__abundio_preexec)
"#;

/// Bash equivalent of the zsh re-export block. Inserted after `/etc/profile`,
/// the login-profile chain AND the deduped `~/.bashrc` — anything earlier and a
/// user rc could still clobber a Workspace variable.
const BASHRC_ENV_BLOCK: &str = r#"
# Re-apply this Workspace's environment variables AFTER the user's rc. See the
# ZSHRC_BODY comment in pty_manager.rs for why precedence matters here.
if [ -n "$ABUNDIO_ENV_KEYS" ]; then
  for __abundio_k in $ABUNDIO_ENV_KEYS; do
    __abundio_s="ABUNDIO_ENV__${__abundio_k}"
    printf -v "$__abundio_k" '%s' "${!__abundio_s}"
    export "$__abundio_k"
    unset "$__abundio_s"
  done
  unset __abundio_k __abundio_s ABUNDIO_ENV_KEYS
fi
case ":$PATH:" in
  *":$ABUNDIO_INTEGRATION_DIR:"*) ;;
  *) [ -n "$ABUNDIO_INTEGRATION_DIR" ] && PATH="$ABUNDIO_INTEGRATION_DIR:$PATH" && export PATH ;;
esac
"#;

/// PowerShell equivalent. `-split` + `Where-Object` rather than
/// `String.Split(char, StringSplitOptions)` for Windows PowerShell 5.1.
const PS1_ENV_BLOCK: &str = r#"
# Re-apply this Workspace's environment variables after the user's profile.
if ($env:ABUNDIO_ENV_KEYS) {
    foreach ($k in ($env:ABUNDIO_ENV_KEYS -split '\s+' | Where-Object { $_ })) {
        $shadow = "ABUNDIO_ENV__$k"
        $val = [Environment]::GetEnvironmentVariable($shadow, 'Process')
        if ($null -ne $val) {
            [Environment]::SetEnvironmentVariable($k, $val, 'Process')
            [Environment]::SetEnvironmentVariable($shadow, $null, 'Process')
        }
    }
    [Environment]::SetEnvironmentVariable('ABUNDIO_ENV_KEYS', $null, 'Process')
}
if ($env:ABUNDIO_INTEGRATION_DIR -and ($env:PATH -notlike "*$env:ABUNDIO_INTEGRATION_DIR*")) {
    $env:PATH = "$env:ABUNDIO_INTEGRATION_DIR" + [IO.Path]::PathSeparator + $env:PATH
}
"#;

fn write_shell_integration_files() -> PathBuf {
    // Epoch-scoped: these files are rewritten unconditionally by whichever
    // build spawns a terminal first. An older build's wrapper scripts have no
    // `ABUNDIO_ENV_KEYS` re-export block, so sharing this directory would let it
    // silently disable this version's environment injection.
    let dir = crate::app_paths::shell_integration_dir();
    write_shell_integration_files_into(&dir);
    dir
}

/// Split out from `write_shell_integration_files` so tests can assert on the
/// generated scripts — in particular that the environment re-export lands after
/// the user's rc — without writing into the real data directory.
fn write_shell_integration_files_into(dir: &Path) {
    let _ = fs::create_dir_all(dir);

    // zsh: wrapper .zshrc that sources user config then adds hooks
    let zshrc = dir.join(".zshrc");
    let _ = fs::write(&zshrc, ZSHRC_BODY);

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
# Reproduce a login + interactive bash startup so panes get both login env
# (PATH etc.) AND interactive config (PS1, aliases) — but source ~/.bashrc
# EXACTLY ONCE. A real `bash -l -i` reads /etc/profile then the first of
# ~/.bash_profile|~/.bash_login|~/.profile; on Debian/Ubuntu those source
# ~/.bashrc themselves. We also want ~/.bashrc for users whose profile does
# not. Sourcing it twice breaks re-source-guarded prompt tools: the second
# pass re-runs ~/.bashrc's own default PS1 line while a guarded tool it loads
# (e.g. nerdps1's `ps1_loaded`) early-returns, leaving the system default
# prompt. So we intercept the profile's ~/.bashrc source and dedupe it.
[ -f /etc/profile ] && source /etc/profile
# Dedup below is intentionally ~/.bashrc-only. On Debian/Ubuntu /etc/profile
# itself sources /etc/bash.bashrc (when PS1 is set), so the next line may run
# it twice — harmless, since ~/.bashrc is sourced last and wins the prompt, and
# no guarded tool ships in /etc/bash.bashrc. (--rcfile suppresses bash's own
# automatic /etc/bash.bashrc + ~/.bashrc loading, hence sourcing it here.)
[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc
# Wrap source/. only while sourcing the login profile files: this records
# whether they already loaded ~/.bashrc and forwards every other source
# untouched (so e.g. .bashrc -> nerdps1 still loads normally).
__abundio_bashrc_loaded=
source() {
  case "$1" in
    "$HOME/.bashrc"|~/.bashrc|.bashrc|./.bashrc) __abundio_bashrc_loaded=1 ;;
  esac
  builtin source "$@"
}
.() { source "$@"; }
if [ -f ~/.bash_profile ]; then
  source ~/.bash_profile
elif [ -f ~/.bash_login ]; then
  source ~/.bash_login
elif [ -f ~/.profile ]; then
  source ~/.profile
fi
unset -f source .
# Only source ~/.bashrc ourselves if the profile files did not already do it.
[ -z "$__abundio_bashrc_loaded" ] && [ -f ~/.bashrc ] && builtin source ~/.bashrc
unset __abundio_bashrc_loaded
__ABUNDIO_ENV_BLOCK__
# Hooks
# Track whether the DEBUG trap is firing for a genuine interactive command
# vs. a command run from PROMPT_COMMAND (e.g. a distro's `history -a`) or tab
# completion. Without this, any pre-existing PROMPT_COMMAND command runs after
# our command_end and the DEBUG trap emits a spurious command_start, leaving
# the pane stuck "busy" at an idle prompt. precmd is appended LAST so all
# other PROMPT_COMMAND commands run before we re-arm the prompt flag.
__abundio_at_prompt=0
__abundio_preexec() {
  [ -n "$COMP_LINE" ] && return
  [ "$__abundio_at_prompt" = 1 ] || return
  __abundio_at_prompt=0
  printf '\e]7770;command_start;%s\a' "$BASH_COMMAND"
}
__abundio_precmd() { printf '\e]7770;command_end;%s\a' "$?"; printf '\e]7770;cwd;%s\a' "$PWD"; __abundio_at_prompt=1; }
trap '__abundio_preexec' DEBUG
# Append precmd LAST so it runs after every other PROMPT_COMMAND command (re-arming
# the prompt flag only once they've all run). bash 5.1+ allows PROMPT_COMMAND to be
# an array — set by GNOME/VTE's /etc/profile.d integration and some prompt tools — and
# a scalar assignment would only replace element [0], leaving later array entries to
# run after command_end and re-trigger a spurious command_start (pane stuck "busy").
# Detect the array form and push onto it instead.
__abundio_pc="$(declare -p PROMPT_COMMAND 2>/dev/null)"
__abundio_pc_flags="${__abundio_pc#declare }"; __abundio_pc_flags="${__abundio_pc_flags%% *}"
if [[ "$__abundio_pc" == *__abundio_precmd* ]]; then
  :  # already installed (e.g. .bashrc sourced twice) — don't double command_end
elif [[ "$__abundio_pc_flags" == *r* ]]; then
  :  # PROMPT_COMMAND is readonly — can't hook it without an error on first prompt
elif [[ "$__abundio_pc_flags" == *[aA]* ]]; then
  PROMPT_COMMAND+=(__abundio_precmd)  # array form (bash 5.1+); -A treated like -a
else
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__abundio_precmd"
fi
unset __abundio_pc __abundio_pc_flags
"#;

    let _ = fs::write(
        &bashrc,
        bashrc_content.replace("__ABUNDIO_ENV_BLOCK__", BASHRC_ENV_BLOCK),
    );

    // PowerShell: wrapper init script that sources user profile then adds hooks
    // Uses [char]0x1b (ESC) and [char]0x07 (BEL) for PS 5.1 compatibility
    // (`e and `a require PS 6+).
    let ps1 = dir.join("abundio_init.ps1");
    let ps1_content = r#"# Abundio shell integration for PowerShell — loaded via -NoProfile -File
# Source the user's profile first
if (Test-Path $PROFILE) { . $PROFILE }
__ABUNDIO_ENV_BLOCK__

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
    # Emit current working directory
    $Host.UI.Write("$Global:__AbundioESC]7770;cwd;$($executionContext.SessionState.Path.CurrentLocation)$Global:__AbundioBEL")
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
"#;
    let _ = fs::write(
        &ps1,
        ps1_content.replace("__ABUNDIO_ENV_BLOCK__", PS1_ENV_BLOCK),
    );

    // The `abundio-env` helper: reads an on-demand Bundle for THIS pane. See
    // Stage F / hook_server.rs. Written here so it lives next to the wrapper
    // rc files that put it on PATH.
    write_abundio_env_helper(dir);
}

/// `abundio-env` — use an on-demand Environment Bundle in the calling pane.
///
/// ```text
/// abundio-env run production -- docker compose up   # recommended
/// abundio-env list
/// abundio-env print production > /tmp/x.env         # explicit, deliberate
/// ```
///
/// `run` applies the Bundle to a child process's environment and execs it. That
/// is the primary path because it is the only one that touches neither disk nor
/// the process table:
///  - No temp file, so nothing for a disk-scraping infostealer to find.
///  - No `eval`, so a value containing quotes or newlines cannot execute. The
///    server emits NUL-delimited records and the reader splits on NUL, which is
///    the one byte an environment variable cannot contain.
///  - No `env KEY=VALUE cmd`, which would expose the values in `ps` output.
///
/// **`--env-file <(abundio-env print …)` does NOT work with Docker Compose.**
/// Compose requires a regular, seekable file and silently treats a process
/// substitution as empty — verified against Compose v5.1.3, no error, just blank
/// values. `run` sidesteps this entirely: Compose reads `${VAR}` interpolation
/// and `environment: [VAR]` passthrough from the shell environment.
///
/// Authentication is the pane's `ABUNDIO_HOOK_TOKEN`, and the Workspace is
/// resolved server-side from `ABUNDIO_PTY_ID` — a caller can name a bundle but
/// never a workspace.
///
/// Bash rather than `/bin/sh`: `read -r -d ''` is needed for NUL-delimited
/// records, and it is absent from POSIX sh. The user's interactive shell is
/// irrelevant — the shebang picks the interpreter.
const ABUNDIO_ENV_SH: &str = r#"#!/usr/bin/env bash
# Abundio — use an on-demand Environment Bundle in this terminal.
#
#   abundio-env run production -- docker compose up
#   abundio-env list
#   abundio-env print production > secrets.env    # writes to DISK, be careful
#
# `run` never writes the values to disk and never puts them in `ps` output.
set -euo pipefail

if [ -z "${ABUNDIO_HOOK_TOKEN:-}" ] || [ -z "${ABUNDIO_PTY_ID:-}" ]; then
  echo "abundio-env: not running inside an Abundio terminal" >&2
  exit 1
fi

# The status of the LAST `__abundio_fetch`. A file rather than a variable
# because `run` fetches inside a process substitution, whose variables die with
# the subshell.
__abundio_codefile=$(mktemp)
trap 'rm -f "$__abundio_codefile"' EXIT

__abundio_fetch() {   # $1 = route, $2 = bundle (optional)
  local body
  if [ -n "${2:-}" ]; then
    body="{\"ptyId\":\"${ABUNDIO_PTY_ID}\",\"bundle\":\"$2\"}"
  else
    body="{\"ptyId\":\"${ABUNDIO_PTY_ID}\"}"
  fi
  # `-f` not `-fS`: curl's own "(22) The requested URL returned error: 404" says
  # nothing about bundles. Every caller routes failure through
  # `__abundio_explain`, which turns the status into a sentence.
  #
  # `%{stderr}` sends the status code to stderr so it cannot be confused with
  # the body on stdout — the body may be NUL-delimited records or a secret, and
  # must reach the caller byte-for-byte. Reading the status from THIS request
  # rather than a second probe matters: /env/raw is the one route that decrypts,
  # so probing it again would re-enter the credential store and, on a locked
  # keychain, prompt a second time for one user command.
  curl -fs -w '%{stderr}%{http_code}' -X POST \
    "http://127.0.0.1:${ABUNDIO_HOOK_PORT}$1" \
    -H "X-Abundio-Token: ${ABUNDIO_HOOK_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>"$__abundio_codefile"
}

__abundio_unknown_pane() {
  echo "abundio-env: Abundio no longer recognises this terminal." >&2
  echo "  Open a new pane and try again." >&2
}

# Turn the last failed fetch into a sentence. Without this the user sees curl's
# own `curl: (22) The requested URL returned error: 404`, which says nothing
# about bundles.
__abundio_explain() {   # $1 = bundle name, empty when the command names none
  local code names
  code=$(cat "$__abundio_codefile" 2>/dev/null) || code=""
  # `%{stderr}` needs curl 7.63+. On anything older the file holds a warning
  # rather than a number, which must degrade to the generic message instead of
  # being printed as a status.
  case "$code" in ''|*[!0-9]*) code="" ;; esac

  case "$code" in
    404)
      # The server answers 404 for an unknown pane as well as an unknown
      # bundle, and `list` names no bundle at all — so only a command that
      # passed a name can blame the name. Even then, the recovery listing
      # settles it: if the pane were still known, /env/list would answer.
      if [ -z "${1:-}" ]; then
        __abundio_unknown_pane
      elif names=$(__abundio_fetch /env/list 2>/dev/null); then
        echo "abundio-env: no bundle named '$1' in this workspace" >&2
        if [ -n "$names" ]; then
          echo "  Available bundles: $(echo "$names" | tr '\n' ' ')" >&2
        else
          echo "  This workspace has no environment bundles yet." >&2
        fi
      else
        __abundio_unknown_pane
      fi
      ;;
    503)
      echo "abundio-env: could not unlock the credential store — is the keychain locked?" >&2
      echo "  Open Abundio's environment settings and retry to re-unlock it." >&2
      ;;
    401|403)
      echo "abundio-env: this terminal is not authorised to read bundles." >&2
      ;;
    2*)
      # `-f` only fails on >= 400, so a 2xx here means the transfer itself
      # broke — a truncated body, not a rejected request.
      echo "abundio-env: the connection to Abundio dropped mid-response — please try again." >&2
      ;;
    ""|000)
      echo "abundio-env: could not reach Abundio — is the app still running?" >&2
      ;;
    *)
      echo "abundio-env: could not reach Abundio (HTTP ${code})." >&2
      ;;
  esac
}

__abundio_usage() {
  cat >&2 <<'USAGE'
abundio-env — on-demand environment bundles for this workspace

  abundio-env run <bundle> -- <command>   run a command with the bundle applied
  abundio-env list                        list available bundles
  abundio-env print <bundle>              print as KEY="value" lines

Note: `docker compose --env-file` needs a real file and will NOT read a process
substitution. Use `run` instead:

  abundio-env run production -- docker compose up
USAGE
}

case "${1:-}" in
  list)
    if ! __abundio_list_out=$(__abundio_fetch /env/list); then
      __abundio_explain ""
      exit 1
    fi
    # Zero bundles is a successful answer to "what bundles exist", not an
    # error — `ls` on an empty directory exits 0 too, and a caller doing
    # `bundles=$(abundio-env list)` under `set -e` must not abort.
    if [ -z "$__abundio_list_out" ]; then
      echo "abundio-env: this workspace has no environment bundles yet." >&2
      exit 0
    fi
    printf '%s\n' "$__abundio_list_out"
    ;;

  run)
    bundle="${2:-}"
    if [ -z "$bundle" ]; then __abundio_usage; exit 2; fi
    shift 2
    [ "${1:-}" = "--" ] && shift
    if [ $# -eq 0 ]; then __abundio_usage; exit 2; fi

    # NUL-delimited KEY=VALUE records: no escaping rules, no eval, and values
    # containing newlines (certificates) survive intact.
    #
    # A process substitution's exit status is invisible to `set -e`, so the
    # fetch status is smuggled out through a file. Without this, a locked
    # keychain or a typo'd bundle name reads zero records and execs the command
    # with NOTHING applied — the same silent-blank-values failure this helper
    # exists to avoid.
    __abundio_status=$(mktemp)
    while IFS= read -r -d '' __abundio_pair; do
      export "${__abundio_pair%%=*}=${__abundio_pair#*=}"
    done < <(__abundio_fetch /env/raw "$bundle"; echo $? >"$__abundio_status")
    __abundio_rc=$(cat "$__abundio_status")
    rm -f "$__abundio_status"
    if [ "$__abundio_rc" != 0 ]; then
      __abundio_explain "$bundle"
      echo "abundio-env: refusing to run '$1' without the bundle applied" >&2
      exit 1
    fi

    # `exec` replaces the process, so the EXIT trap never fires.
    rm -f "$__abundio_codefile"
    exec "$@"
    ;;

  print)
    bundle="${2:-}"
    if [ -z "$bundle" ]; then __abundio_usage; exit 2; fi
    # Abundio persists scrollback to disk, so dumping secrets to a terminal
    # would write them straight into a log file — the very thing this feature
    # exists to avoid. Redirecting or piping is fine.
    if [ -t 1 ] && [ "${3:-}" != "--force" ]; then
      echo "abundio-env: refusing to print secrets to a terminal." >&2
      echo "  Use:  abundio-env run $bundle -- <command>" >&2
      echo "  Override with --force if you really want them on screen." >&2
      exit 3
    fi
    if ! __abundio_print_out=$(__abundio_fetch /env/print "$bundle"); then
      __abundio_explain "$bundle"
      exit 1
    fi
    printf '%s\n' "$__abundio_print_out"
    ;;

  *)
    __abundio_usage
    exit 2
    ;;
esac
"#;

/// PowerShell twin. `run` works the same way (set the variables on the current
/// process, then invoke), so the Windows story is no worse than the Unix one —
/// which is the opposite of what the `--env-file` approach would have given us.
const ABUNDIO_ENV_PS1: &str = r#"# Abundio — use an on-demand Environment Bundle in this terminal.
#   abundio-env run production -- docker compose up
param([Parameter(Position=0)][string]$Command, [Parameter(Position=1)][string]$Bundle, [switch]$Force, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)

if (-not $env:ABUNDIO_HOOK_TOKEN -or -not $env:ABUNDIO_PTY_ID) {
    Write-Error "abundio-env: not running inside an Abundio terminal"; exit 1
}

$headers = @{ "X-Abundio-Token" = $env:ABUNDIO_HOOK_TOKEN }
$base = "http://127.0.0.1:$env:ABUNDIO_HOOK_PORT"

# Turn a failed request into a sentence, so the user never sees a bare HTTP
# error for what is almost always a mistyped bundle name. Must classify the same
# statuses as the bash twin's `__abundio_explain`, or a user's diagnosis depends
# on their OS.
#
# `[Console]::Error.WriteLine` rather than `Write-Host` for the follow-up lines:
# Write-Host goes to the information stream, so `abundio-env print bad 2>$null`
# would silence the headline but leave the detail on screen — the opposite of
# the bash behaviour.
function Write-AbundioFailure([System.Management.Automation.ErrorRecord]$Err, [string]$BundleName) {
    $code = 0
    if ($Err.Exception.Response) { $code = [int]$Err.Exception.Response.StatusCode }
    switch ($code) {
        404 {
            # 404 is also the answer for an unknown pane, and `list` names no
            # bundle — so only a command that passed a name can blame the name,
            # and the recovery listing settles which it was.
            if (-not $BundleName) { Write-AbundioUnknownPane; break }
            $names = $null
            try {
                $body = @{ ptyId = $env:ABUNDIO_PTY_ID } | ConvertTo-Json -Compress
                $names = Invoke-RestMethod -Uri "$base/env/list" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
            } catch { Write-AbundioUnknownPane; break }
            Write-Error "abundio-env: no bundle named '$BundleName' in this workspace"
            if ($names) { [Console]::Error.WriteLine("  Available bundles: $($names -replace "`n", ' ')") }
            else { [Console]::Error.WriteLine("  This workspace has no environment bundles yet.") }
        }
        401 { Write-Error "abundio-env: this terminal is not authorised to read bundles." }
        403 { Write-Error "abundio-env: this terminal is not authorised to read bundles." }
        503 {
            Write-Error "abundio-env: could not unlock the credential store - is the keychain locked?"
            [Console]::Error.WriteLine("  Open Abundio's environment settings and retry to re-unlock it.")
        }
        0 { Write-Error "abundio-env: could not reach Abundio - is the app still running?" }
        # Three digits to match curl's `000` in the bash twin.
        default { Write-Error "abundio-env: could not reach Abundio (HTTP $('{0:000}' -f $code))." }
    }
}

function Write-AbundioUnknownPane {
    Write-Error "abundio-env: Abundio no longer recognises this terminal."
    [Console]::Error.WriteLine("  Open a new pane and try again.")
}

switch ($Command) {
    "list" {
        $body = @{ ptyId = $env:ABUNDIO_PTY_ID } | ConvertTo-Json -Compress
        try {
            $names = Invoke-RestMethod -Uri "$base/env/list" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
        } catch {
            Write-AbundioFailure $_ ""
            exit 1
        }
        # Zero bundles is a successful answer, not an error — same contract as
        # the bash twin, which exits 0 here.
        if (-not $names) {
            [Console]::Error.WriteLine("abundio-env: this workspace has no environment bundles yet.")
            exit 0
        }
        $names
    }
    "run" {
        if (-not $Bundle) { Write-Error "abundio-env: usage: abundio-env run <bundle> -- <command>"; exit 2 }
        $args2 = @($Rest | Where-Object { $_ -ne "--" })
        if ($args2.Count -eq 0) { Write-Error "abundio-env: usage: abundio-env run <bundle> -- <command>"; exit 2 }

        # NUL-delimited KEY=VALUE records: split on a byte that cannot occur in a
        # value, so nothing is ever evaluated as code and a value containing
        # quotes or newlines cannot execute.
        $body = @{ ptyId = $env:ABUNDIO_PTY_ID; bundle = $Bundle } | ConvertTo-Json -Compress
        # Invoke-RestMethod's HTTP failure is statement-terminating, not
        # script-terminating, so without this catch execution falls through and
        # runs the command with no variables set.
        try {
            $raw = Invoke-RestMethod -Uri "$base/env/raw" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
        } catch {
            Write-AbundioFailure $_ $Bundle
            Write-Error "abundio-env: refusing to run '$($args2[0])' without the bundle applied"
            exit 1
        }
        foreach ($record in ($raw -split "`0")) {
            if (-not $record) { continue }
            $i = $record.IndexOf('=')
            if ($i -lt 1) { continue }
            [Environment]::SetEnvironmentVariable($record.Substring(0, $i), $record.Substring($i + 1), 'Process')
        }
        # Skip-based, not range-based: an index range from 1 to the last element
        # descends when the command has a single token, which would pass the
        # command name to itself as an argument.
        $rest = @($args2 | Select-Object -Skip 1)
        & $args2[0] @rest
        exit $LASTEXITCODE
    }
    "print" {
        if (-not $Bundle) { Write-Error "abundio-env: usage: abundio-env print <bundle>"; exit 2 }
        # Scrollback is persisted to disk, so refuse an interactive dump.
        if (-not $Force -and -not [Console]::IsOutputRedirected) {
            Write-Error "abundio-env: refusing to print secrets to a terminal. Redirect the output or pass -Force."
            exit 3
        }
        $body = @{ ptyId = $env:ABUNDIO_PTY_ID; bundle = $Bundle } | ConvertTo-Json -Compress
        try {
            Invoke-RestMethod -Uri "$base/env/print" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
        } catch {
            Write-AbundioFailure $_ $Bundle
            exit 1
        }
    }
    default { Write-Error "abundio-env: usage: abundio-env {run <bundle> -- <cmd>|list|print <bundle>}"; exit 2 }
}
"#;

fn write_abundio_env_helper(dir: &Path) {
    let sh = dir.join("abundio-env");
    if fs::write(&sh, ABUNDIO_ENV_SH).is_ok() {
        // Must be executable to be usable from PATH.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&sh, fs::Permissions::from_mode(0o755));
        }
    }
    let _ = fs::write(dir.join("abundio-env.ps1"), ABUNDIO_ENV_PS1);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msys_drive_paths_become_native() {
        assert_eq!(msys_to_windows_path("/c/Users/x"), "c:/Users/x");
        assert_eq!(msys_to_windows_path("/d/repos/abundio"), "d:/repos/abundio");
        assert_eq!(msys_to_windows_path("/c"), "c:");
        assert_eq!(msys_to_windows_path("/c/"), "c:/");
    }

    #[test]
    fn msys_unc_paths_become_native() {
        assert_eq!(
            msys_to_windows_path("//server/share/x"),
            "\\\\server\\share\\x"
        );
    }

    #[test]
    fn non_msys_paths_pass_through() {
        // Already-native Windows paths.
        assert_eq!(msys_to_windows_path("C:/already/native"), "C:/already/native");
        assert_eq!(
            msys_to_windows_path("C:\\already\\native"),
            "C:\\already\\native"
        );
        // MSYS root paths that aren't a single-letter drive segment.
        assert_eq!(msys_to_windows_path("/usr/bin"), "/usr/bin");
        // POSIX absolute (multi-char first segment) and relative paths.
        assert_eq!(msys_to_windows_path("/Users/emil/dev"), "/Users/emil/dev");
        assert_eq!(msys_to_windows_path("relative/path"), "relative/path");
        assert_eq!(msys_to_windows_path(""), "");
    }
}

#[cfg(test)]
mod env_injection_tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn emits_both_the_plain_and_shadow_forms() {
        let (pairs, keys, skipped) = build_env_injection(&vars(&[("TOKEN", "abc")]), 64 * 1024, true);
        assert!(pairs.contains(&("TOKEN".into(), "abc".into())));
        assert!(pairs.contains(&("ABUNDIO_ENV__TOKEN".into(), "abc".into())));
        assert_eq!(keys, "TOKEN");
        assert!(skipped.is_empty());
    }

    #[test]
    fn manifest_is_space_separated_in_resolution_order() {
        let (_, keys, _) = build_env_injection(
            &vars(&[("A", "1"), ("B", "2"), ("C", "3")]),
            64 * 1024,
            true,
        );
        assert_eq!(keys, "A B C");
    }

    /// Shells with no wrapper rc never consume the shadow copies, so emitting
    /// them would leave `ABUNDIO_ENV__*` and the manifest lingering in the
    /// environment of that shell and every child.
    #[test]
    fn no_shadow_copies_for_shells_without_a_wrapper() {
        let (pairs, keys, _) =
            build_env_injection(&vars(&[("TOKEN", "abc")]), 64 * 1024, false);
        assert_eq!(pairs, vec![("TOKEN".to_string(), "abc".to_string())]);
        assert!(
            keys.is_empty(),
            "no manifest without a wrapper to act on it"
        );
        assert!(!pairs.iter().any(|(k, _)| k.starts_with("ABUNDIO_ENV__")));
    }

    /// The wrapper scripts guard on `[ -n "$ABUNDIO_ENV_KEYS" ]`, so with no
    /// variables the manifest must be empty and the caller must skip setting it
    /// at all rather than exporting an empty string.
    #[test]
    fn empty_input_produces_no_manifest() {
        let (pairs, keys, skipped) = build_env_injection(&[], 64 * 1024, true);
        assert!(pairs.is_empty());
        assert!(keys.is_empty());
        assert!(skipped.is_empty());
    }

    #[test]
    fn values_with_newlines_survive_unchanged() {
        let pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
        let (pairs, _, _) = build_env_injection(&vars(&[("CERT", pem)]), 64 * 1024, true);
        assert_eq!(pairs[0].1, pem);
        assert_eq!(pairs[1].1, pem);
    }

    /// Exceeding the OS environment-block limit makes `spawn_command` FAIL on
    /// Windows, which would kill the pane. Oversize variables must be dropped
    /// and reported, never allowed through.
    #[test]
    fn truncates_at_the_budget_and_reports_what_was_dropped() {
        let big = "x".repeat(500);
        let (pairs, keys, skipped) =
            build_env_injection(&vars(&[("SMALL", "1"), ("BIG", &big)]), 200, true);
        assert!(pairs.iter().any(|(k, _)| k == "SMALL"));
        assert!(!pairs.iter().any(|(k, _)| k == "BIG"));
        assert_eq!(keys, "SMALL");
        assert_eq!(skipped, vec!["BIG".to_string()]);
    }
}

#[cfg(test)]
mod wrapper_script_tests {
    use super::*;

    /// PRECEDENCE GUARD. The re-export block must come AFTER the user's rc is
    /// sourced, or a plain `export FOO=...` in `.zshrc` silently beats the
    /// Workspace value. This test exists so that "tidying" the scripts cannot
    /// quietly reverse that.
    #[test]
    fn zsh_reexports_after_sourcing_the_user_rc() {
        let source_at = ZSHRC_BODY
            .find("source \"$ABUNDIO_ORIGINAL_ZDOTDIR/.zshrc\"")
            .expect("zsh wrapper should source the user's rc");
        let reexport_at = ZSHRC_BODY
            .find("ABUNDIO_ENV_KEYS")
            .expect("zsh wrapper should re-export workspace variables");
        assert!(
            reexport_at > source_at,
            "the env re-export must run AFTER the user's rc"
        );
    }

    #[test]
    fn bash_env_block_lands_after_the_user_rc() {
        let bashrc = written_bashrc();
        let source_at = bashrc
            .rfind("builtin source ~/.bashrc")
            .expect("bash wrapper should source ~/.bashrc");
        let reexport_at = bashrc
            .find("ABUNDIO_ENV_KEYS")
            .expect("bash wrapper should re-export workspace variables");
        assert!(
            reexport_at > source_at,
            "the env re-export must run AFTER ~/.bashrc"
        );
    }

    #[test]
    fn powershell_env_block_lands_after_the_user_profile() {
        let block_at = PS1_ENV_BLOCK
            .find("ABUNDIO_ENV_KEYS")
            .expect("ps1 block should re-export workspace variables");
        assert!(block_at > 0);
        // The placeholder sits immediately after `. $PROFILE` in the template.
        assert!(PS1_ENV_BLOCK.contains("SetEnvironmentVariable"));
    }

    /// Values are arbitrary user data — certificates, tokens, anything with
    /// quotes or newlines. `eval` in these scripts would turn a stored value
    /// into a code-execution vector.
    #[test]
    fn wrapper_scripts_never_use_eval() {
        for (name, body) in [
            ("zshrc", ZSHRC_BODY),
            ("bashrc-env", BASHRC_ENV_BLOCK),
            ("ps1-env", PS1_ENV_BLOCK),
            ("abundio-env.sh", ABUNDIO_ENV_SH),
        ] {
            assert!(!body.contains("eval "), "{name} must not use eval");
        }
    }

    #[test]
    fn wrappers_put_the_integration_dir_on_path() {
        assert!(ZSHRC_BODY.contains("ABUNDIO_INTEGRATION_DIR"));
        assert!(BASHRC_ENV_BLOCK.contains("ABUNDIO_INTEGRATION_DIR"));
        assert!(PS1_ENV_BLOCK.contains("ABUNDIO_INTEGRATION_DIR"));
    }

    /// Scrollback is persisted to disk, so an interactive dump would write
    /// every secret into a log file.
    #[test]
    fn helper_refuses_to_print_to_a_tty() {
        assert!(ABUNDIO_ENV_SH.contains("[ -t 1 ]"));
        assert!(ABUNDIO_ENV_SH.contains("refusing to print secrets"));
        assert!(ABUNDIO_ENV_PS1.contains("IsOutputRedirected"));
    }

    /// `run` is the recommended path precisely because it avoids the two
    /// exposures `print` cannot: a temp file on disk and values in `ps` output.
    #[test]
    fn helper_run_execs_without_a_temp_file_or_ps_exposure() {
        assert!(ABUNDIO_ENV_SH.contains("/env/raw"));
        assert!(ABUNDIO_ENV_SH.contains("read -r -d ''"));
        assert!(ABUNDIO_ENV_SH.contains("exec \"$@\""));
        // `env KEY=VALUE cmd` would put every value into the process table.
        assert!(
            !ABUNDIO_ENV_SH.contains("env \""),
            "must not pass values as argv"
        );
        assert!(ABUNDIO_ENV_PS1.contains("/env/raw"));
        assert!(!ABUNDIO_ENV_PS1.contains("Invoke-Expression"));
    }

    /// Docker Compose silently ignores a process-substitution `--env-file`
    /// (verified against Compose v5.1.3: no error, blank values). The helper
    /// must not suggest it — a silently-empty environment is far worse than a
    /// missing feature.
    #[test]
    fn helper_does_not_recommend_env_file_process_substitution() {
        assert!(
            !ABUNDIO_ENV_SH.contains("--env-file <("),
            "compose cannot read a process substitution"
        );
        assert!(ABUNDIO_ENV_SH.contains("abundio-env run production -- docker compose up"));
    }

    /// A process substitution's exit status is invisible to `set -e`, so
    /// without an explicit check a failed fetch execs the command with NO
    /// variables — the exact silent-blank-values failure this helper replaced
    /// `--env-file` to avoid.
    #[test]
    fn helper_run_aborts_when_the_fetch_fails() {
        assert!(ABUNDIO_ENV_SH.contains("__abundio_rc"));
        // The exact message, so the ordering assertion below pins a unique
        // substring rather than the first of several near-matches.
        const ABORT: &str = "refusing to run '$1' without the bundle applied";
        assert!(ABUNDIO_ENV_SH.contains(ABORT));
        // The abort must come BEFORE the exec.
        let check = ABUNDIO_ENV_SH.find(ABORT).unwrap();
        let exec = ABUNDIO_ENV_SH.find("exec \"$@\"").unwrap();
        assert!(check < exec, "the status check must precede exec");

        assert!(ABUNDIO_ENV_PS1.contains("without the bundle applied"));
        assert!(ABUNDIO_ENV_PS1.contains("} catch {"));
    }

    /// A mistyped bundle name is the most likely way to hit a failed fetch, and
    /// it used to surface as curl's own `(22) The requested URL returned error:
    /// 404` — which says nothing about bundles. Every subcommand must go through
    /// the explainer instead.
    #[test]
    fn helper_explains_an_unknown_bundle_instead_of_leaking_curl() {
        assert!(ABUNDIO_ENV_SH.contains("no bundle named"));
        assert!(ABUNDIO_ENV_SH.contains("Available bundles:"));
        assert!(ABUNDIO_ENV_SH.contains("credential store"));

        // Every route's failure reaches the explainer. Counting call sites
        // instead would break the moment a fourth route is added, without
        // saying why.
        for route in ["/env/list", "/env/raw", "/env/print"] {
            let at = ABUNDIO_ENV_SH
                .find(&format!("__abundio_fetch {route}"))
                .unwrap_or_else(|| panic!("{route} must be fetched"));
            assert!(
                ABUNDIO_ENV_SH[at..].contains("__abundio_explain"),
                "{route}'s failure must reach the explainer"
            );
        }
        assert_eq!(ABUNDIO_ENV_PS1.matches("Write-AbundioFailure $_").count(), 3);
    }

    /// The two scripts must classify the same statuses, or a user's diagnosis
    /// depends on their OS — which is how the PowerShell twin first shipped
    /// without the 401/403 arm that bash had.
    #[test]
    fn both_helpers_classify_the_same_statuses() {
        for code in ["404", "503", "401", "403"] {
            assert!(
                ABUNDIO_ENV_SH.contains(code),
                "sh explainer is missing a {code} arm"
            );
            assert!(
                ABUNDIO_ENV_PS1.contains(code),
                "ps1 explainer is missing a {code} arm"
            );
        }
        // A 404 means "unknown pane" as well as "unknown bundle"; both scripts
        // must be able to say so rather than blaming an empty bundle name.
        for (name, body) in [("sh", ABUNDIO_ENV_SH), ("ps1", ABUNDIO_ENV_PS1)] {
            assert!(
                body.contains("no longer recognises this terminal"),
                "{name} must distinguish an unknown pane from an unknown bundle"
            );
            assert!(
                body.contains("not authorised to read bundles"),
                "{name} must name an auth failure"
            );
        }
    }

    /// Zero bundles is a successful answer to "what bundles exist" — a caller
    /// doing `bundles=$(abundio-env list)` under `set -e` must not abort, and
    /// the two scripts must agree on it.
    #[test]
    fn empty_bundle_list_exits_zero_on_both_platforms() {
        let sh_at = ABUNDIO_ENV_SH
            .find("abundio-env: this workspace has no environment bundles yet")
            .expect("sh must report an empty list");
        assert!(
            ABUNDIO_ENV_SH[sh_at..].starts_with(
                "abundio-env: this workspace has no environment bundles yet.\" >&2\n      exit 0"
            ),
            "an empty list must exit 0"
        );
        let ps_at = ABUNDIO_ENV_PS1
            .find("abundio-env: this workspace has no environment bundles yet")
            .expect("ps1 must report an empty list");
        assert!(
            ABUNDIO_ENV_PS1[ps_at..].contains("exit 0"),
            "an empty list must exit 0 on Windows too"
        );
    }

    /// `/env/raw` is the one route that decrypts. Probing it a second time
    /// purely to read a status code would re-enter the credential store and,
    /// on a locked keychain, prompt twice for a single user command.
    #[test]
    fn helper_reads_the_status_from_the_request_it_already_made() {
        assert!(ABUNDIO_ENV_SH.contains("%{stderr}%{http_code}"));
        assert!(ABUNDIO_ENV_SH.contains("__abundio_codefile"));
        // The explainer takes a bundle name, not a route — it cannot re-request.
        assert!(!ABUNDIO_ENV_SH.contains("__abundio_explain /env/"));
        // `exec` skips the EXIT trap, so the temp file is removed explicitly.
        let rm = ABUNDIO_ENV_SH.find("rm -f \"$__abundio_codefile\"\n    exec");
        assert!(rm.is_some(), "the code file must be cleaned up before exec");
    }

    /// `Write-Host` goes to the information stream, so a diagnostic written
    /// with it survives `2>$null` — unlike its bash counterpart on `>&2`.
    #[test]
    fn powershell_diagnostics_go_to_stderr() {
        // The prose above the function may name it; no call site may use it.
        assert!(!ABUNDIO_ENV_PS1.contains("Write-Host \""));
        assert!(!ABUNDIO_ENV_PS1.contains("Write-Host $"));
        assert!(ABUNDIO_ENV_PS1.contains("[Console]::Error.WriteLine"));
    }

    /// `$args2[1..($args2.Count - 1)]` is a DESCENDING range for a single-token
    /// command, which passes the command name to itself.
    #[test]
    fn powershell_run_handles_a_command_with_no_arguments() {
        assert!(ABUNDIO_ENV_PS1.contains("Select-Object -Skip 1"));
        assert!(!ABUNDIO_ENV_PS1.contains("$args2.Count - 1"));
    }

    #[test]
    fn helper_requires_the_pane_token() {
        assert!(ABUNDIO_ENV_SH.contains("ABUNDIO_HOOK_TOKEN"));
        assert!(ABUNDIO_ENV_SH.contains("not running inside an Abundio terminal"));
        assert!(ABUNDIO_ENV_PS1.contains("ABUNDIO_HOOK_TOKEN"));
    }

    /// The placeholder must actually be substituted — a typo would ship a
    /// wrapper containing the literal `__ABUNDIO_ENV_BLOCK__`.
    #[test]
    fn placeholders_are_substituted() {
        let bashrc = written_bashrc();
        assert!(!bashrc.contains("__ABUNDIO_ENV_BLOCK__"));
        assert!(bashrc.contains("printf -v"));
    }

    /// Mirrors the substitution `write_shell_integration_files` performs,
    /// without touching the real data directory.
    ///
    /// `tempfile::tempdir` rather than a fixed name under `env::temp_dir`: that
    /// directory is shared between users, so a predictable name is the classic
    /// insecure-temp-file pattern (flagged by
    /// `rust.lang.security.temp-dir.temp-dir`). Test-only, but the correct
    /// spelling costs nothing and `tempfile` is already a dependency.
    fn written_bashrc() -> String {
        let dir = tempfile::tempdir().expect("temp dir");
        write_shell_integration_files_into(dir.path());
        fs::read_to_string(dir.path().join(".bashrc"))
            .expect("bashrc should have been written")
    }
}

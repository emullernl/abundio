use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use base64::Engine;
use crossbeam_channel::{self, Receiver, Sender};
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;
use crate::events::{PtyOutput, PtyStatus};
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
    ) -> Result<String, AbundioError> {
        let pty_id = uuid::Uuid::new_v4().to_string();

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
        let mut cmd = if let Some(command) = command {
            let parts: Vec<&str> = command.split_whitespace().collect();
            let mut cmd = CommandBuilder::new(parts[0]);
            for arg in &parts[1..] {
                cmd.arg(arg);
            }
            cmd
        } else {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.args(["-l", "-i"]); // login + interactive shell (sources .zshrc)
            cmd
        };

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
            pty_thread(id_clone, master, child, rx, alive, app, log_file);
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

/// Runs on a dedicated OS thread. Owns the master PTY and child process.
fn pty_thread(
    pty_id: String,
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    rx: Receiver<PtyCommand>,
    alive: Arc<AtomicBool>,
    app: AppHandle,
    log_file: Option<(File, PathBuf)>,
) {
    let mut writer = master.take_writer().unwrap();
    let mut reader = master.try_clone_reader().unwrap();

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

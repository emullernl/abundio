//! In-app updater (Tauri updater plugin + GitHub Releases). See ADR-0014.
//!
//! The version *check* runs here in Rust — the single source of truth — and
//! emits `update-available` to the focused Window only, so N open Windows don't
//! each surface a prompt. Updates are **downloaded eagerly** when the user
//! accepts, then **installed on the next natural quit** (`apply_staged_update_on_quit`,
//! wired into the quit paths in `lib.rs`) so live PTYs and mid-turn Agents are
//! never killed mid-session. "Install & Restart now" (`updater_install_now`) is
//! the only path that interrupts running work, and the frontend guards it behind
//! an explicit confirm.
//!
//! Everything goes through these `#[tauri::command]`s rather than the JS updater
//! plugin, so no extra capability permissions are required (app-defined commands
//! are already callable from every Window).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AbundioError;

/// Delay before the first auto-check so it stays off the launch critical path.
const INITIAL_CHECK_DELAY: Duration = Duration::from_secs(8);
/// Interval between background auto-checks for long-running sessions.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Update metadata surfaced to the frontend. Mirrors the relevant fields of
/// `tauri_plugin_updater::Update`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Download progress, emitted as `update-download-progress`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Managed state holding the most recent check result and, once downloaded, the
/// staged installer bytes ready to apply on quit or on demand.
pub struct UpdaterState {
    inner: Mutex<UpdaterInner>,
    /// Whether the background loop should hit the network. Mirrors the frontend
    /// "Automatically check for updates" setting. The manual "Check now" button
    /// bypasses this entirely.
    auto_check: AtomicBool,
}

#[derive(Default)]
struct UpdaterInner {
    /// Result of the last check, consumed by `download`.
    pending: Option<Update>,
    /// Downloaded installer bytes + the matching `Update`, ready to install.
    staged: Option<(Update, Vec<u8>)>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UpdaterInner::default()),
            auto_check: AtomicBool::new(true),
        }
    }
}

fn to_info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.map(|d| d.to_string()),
    }
}

/// Runs a check and, if an update is available, stashes it as `pending` and
/// emits `update-available` to the focused Window. Shared by the background
/// loop; the manual command path uses `updater_check` directly.
async fn check_and_emit(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        let info = to_info(&update);
        if let Some(state) = app.try_state::<UpdaterState>() {
            state.inner.lock().unwrap().pending = Some(update);
        }
        // Focused-Window-only so multiple Windows don't each prompt. See ADR-0014.
        let _ = crate::emit_to_focused(app, "update-available", &info);
    }
    Ok(())
}

/// Spawns the background auto-check loop: one check shortly after launch, then
/// on a fixed interval, skipping the network entirely when auto-check is off.
pub fn start_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_CHECK_DELAY).await;
        loop {
            let enabled = app
                .try_state::<UpdaterState>()
                .map(|s| s.auto_check.load(Ordering::Relaxed))
                .unwrap_or(false);
            if enabled {
                if let Err(e) = check_and_emit(&app).await {
                    eprintln!("[abundio] auto update check failed: {e}");
                }
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Installs a staged update, if any, as part of shutdown. Idempotent — the
/// staged bytes are taken out on the first call, so the multiple quit paths in
/// `lib.rs` can each call it safely. Best-effort; logs on failure rather than
/// blocking the quit. On macOS/Linux this swaps the bundle in place; on Windows
/// it launches the (passive) installer as the app exits.
pub fn apply_staged_update_on_quit(app: &AppHandle) {
    let staged = app
        .try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().unwrap().staged.take());
    if let Some((update, bytes)) = staged {
        if let Err(e) = update.install(bytes) {
            eprintln!("[abundio] staged update install on quit failed: {e}");
        }
    }
}

// ── Commands ──

/// Manual check (the Settings "Check for updates" button). Stashes any found
/// update as `pending` and returns its info; `None` means up to date.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<UpdateInfo>, AbundioError> {
    let updater = app
        .updater()
        .map_err(|e| AbundioError::InvalidOperation(format!("updater unavailable: {e}")))?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = to_info(&update);
            state.inner.lock().unwrap().pending = Some(update);
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(AbundioError::InvalidOperation(format!(
            "update check failed: {e}"
        ))),
    }
}

/// Downloads the pending update's installer, emitting `update-download-progress`
/// as bytes arrive, and stages it for install. The bundle is NOT applied here —
/// that happens on quit (default) or via `updater_install_now`.
#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), AbundioError> {
    // Take ownership of the pending update so we can hold it across the await.
    let update = state
        .inner
        .lock()
        .unwrap()
        .pending
        .take()
        .ok_or_else(|| AbundioError::InvalidOperation("no pending update to download".into()))?;

    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let progress_downloaded = downloaded.clone();

    let bytes = update
        .download(
            move |chunk_len, content_len| {
                let total = progress_downloaded.fetch_add(chunk_len as u64, Ordering::Relaxed)
                    + chunk_len as u64;
                let _ = progress_app.emit(
                    "update-download-progress",
                    DownloadProgress {
                        downloaded: total,
                        total: content_len,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| AbundioError::InvalidOperation(format!("update download failed: {e}")))?;

    state.inner.lock().unwrap().staged = Some((update, bytes));
    Ok(())
}

/// Installs the staged update immediately and restarts the app. The frontend
/// guards this behind an explicit confirm (it terminates all Windows, PTYs and
/// Agents). `app.restart()` never returns.
#[tauri::command]
pub async fn updater_install_now(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), AbundioError> {
    let staged = state.inner.lock().unwrap().staged.take();
    let (update, bytes) =
        staged.ok_or_else(|| AbundioError::InvalidOperation("no staged update to install".into()))?;
    update
        .install(bytes)
        .map_err(|e| AbundioError::InvalidOperation(format!("update install failed: {e}")))?;
    app.restart();
}

/// Enables/disables the background auto-check loop's network calls. Called by
/// the frontend on startup (from the persisted setting) and on toggle change;
/// the Rust flag is the app-wide source of truth across all Windows.
#[tauri::command]
pub async fn updater_set_auto_check(
    state: State<'_, UpdaterState>,
    enabled: bool,
) -> Result<(), AbundioError> {
    state.auto_check.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_check_defaults_on() {
        let state = UpdaterState::new();
        assert!(state.auto_check.load(Ordering::Relaxed));
        state.auto_check.store(false, Ordering::Relaxed);
        assert!(!state.auto_check.load(Ordering::Relaxed));
    }

    #[test]
    fn fresh_state_has_no_pending_or_staged() {
        let state = UpdaterState::new();
        let inner = state.inner.lock().unwrap();
        assert!(inner.pending.is_none());
        assert!(inner.staged.is_none());
    }
}

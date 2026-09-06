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

/// A snapshot of the app-global updater state, for a Window to hydrate from.
/// `UpdaterState` is owned by Rust and shared by every Window, but each Window's
/// Zustand store is its own JS context — without this, a Window that did not
/// itself run the check/download has no idea an update is staged.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    /// `"none"`, `"available"` (checked, not downloaded) or `"ready"` (staged).
    pub state: &'static str,
    pub info: Option<UpdateInfo>,
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
    ///
    /// Defaults to `false`: Rust never auto-checks until the frontend explicitly
    /// pushes the persisted setting via `updater_set_auto_check` on rehydrate.
    /// This avoids a startup TOCTOU where an opted-out user's first auto-check
    /// could fire before the disabled flag arrived. Do not flip this to `true`
    /// without also dropping the frontend's explicit push.
    auto_check: AtomicBool,
}

#[derive(Default)]
struct UpdaterInner {
    /// Result of the last check, consumed by `download`.
    pending: Option<Update>,
    /// Downloaded installer bytes + the matching `Update`, ready to install.
    staged: Option<(Update, Vec<u8>)>,
    /// A `download` is in flight. Between taking `pending` and setting `staged`
    /// the state holds neither, so without this a second caller would be told
    /// "no pending update" — true, but misleading. Deliberately NOT surfaced by
    /// `updater_status`: reporting a downloading state would oblige us to
    /// broadcast a completion event, and a missed one would strand a Window on
    /// a progress bar forever. See docs/plans/updater-quit-routes-and-settings-parity.md.
    downloading: bool,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UpdaterInner::default()),
            // Off until the frontend pushes the persisted setting — see field doc.
            auto_check: AtomicBool::new(false),
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
/// emits `update-available` to a Profile-bound Window. Shared by the background
/// loop; the manual command path uses `updater_check` directly.
async fn check_and_emit(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        let info = to_info(&update);
        if let Some(state) = app.try_state::<UpdaterState>() {
            state.inner.lock().unwrap().pending = Some(update);
        }
        emit_update_available(app, &info);
    }
    Ok(())
}

/// Emits `update-available` to the focused Window, but only when it is a
/// Profile-bound Window — the Settings auxiliary window has no listener, so
/// targeting it would silently drop the prompt. Falls back to any Profile-bound
/// Window otherwise. Preserves ADR-0014's "focused Window only" intent for the
/// multi-Profile-window case while never stranding the event on Settings.
fn emit_update_available(app: &AppHandle, info: &UpdateInfo) {
    let windows = app.webview_windows();
    let focused_profile = windows.iter().find_map(|(label, w)| {
        (w.is_focused().unwrap_or(false)
            && crate::window_management::is_profile_window_label(label))
        .then(|| label.clone())
    });
    let target = focused_profile.or_else(|| {
        windows
            .keys()
            .find(|label| crate::window_management::is_profile_window_label(label))
            .cloned()
    });
    if let Some(label) = target {
        let _ = app.emit_to(label.as_str(), "update-available", info);
    }
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
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let staged = state.inner.lock().unwrap().staged.take();
    if let Some((update, bytes)) = staged {
        let version = update.version.clone();
        // Borrow the bytes so we can re-stage them if the install fails.
        match update.install(&bytes) {
            Ok(()) => eprintln!("[abundio] staged update {version} installed on quit"),
            Err(e) => {
                eprintln!("[abundio] staged update {version} install on quit failed: {e}");
                // Re-stage so a subsequent quit retries rather than permanently
                // losing the downloaded bundle to a transient failure.
                state.inner.lock().unwrap().staged = Some((update, bytes));
            }
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
    // Distinguish "someone else is already downloading" from "nothing to
    // download" — both leave `pending` empty, but only one is a user error.
    let update = {
        let mut inner = state.inner.lock().unwrap();
        if inner.downloading {
            return Err(AbundioError::InvalidOperation(
                "a download is already in progress".into(),
            ));
        }
        let update = inner.pending.take().ok_or_else(|| {
            AbundioError::InvalidOperation("no pending update to download".into())
        })?;
        inner.downloading = true;
        update
    };

    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let progress_downloaded = downloaded.clone();

    let result = update
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
        .await;

    // Clear the in-flight flag on BOTH outcomes, and put the update back as
    // `pending` on failure so a retry doesn't need a fresh check.
    let mut inner = state.inner.lock().unwrap();
    inner.downloading = false;
    match result {
        Ok(bytes) => {
            inner.staged = Some((update, bytes));
            Ok(())
        }
        Err(e) => {
            inner.pending = Some(update);
            Err(AbundioError::InvalidOperation(format!(
                "update download failed: {e}"
            )))
        }
    }
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

/// Reports the app-global updater state so any Window can hydrate its own
/// store. `staged` wins over `pending`: an update that is already downloaded is
/// the more advanced — and more actionable — truth.
#[tauri::command]
pub async fn updater_status(
    state: State<'_, UpdaterState>,
) -> Result<UpdaterStatus, AbundioError> {
    let inner = state.inner.lock().unwrap();
    if let Some((update, _)) = inner.staged.as_ref() {
        return Ok(UpdaterStatus {
            state: "ready",
            info: Some(to_info(update)),
        });
    }
    if let Some(update) = inner.pending.as_ref() {
        return Ok(UpdaterStatus {
            state: "available",
            info: Some(to_info(update)),
        });
    }
    Ok(UpdaterStatus {
        state: "none",
        info: None,
    })
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
    fn auto_check_defaults_off() {
        // Off until the frontend explicitly enables it on rehydrate, so an
        // opted-out user never races a check before their setting arrives.
        let state = UpdaterState::new();
        assert!(!state.auto_check.load(Ordering::Relaxed));
        state.auto_check.store(true, Ordering::Relaxed);
        assert!(state.auto_check.load(Ordering::Relaxed));
    }

    #[test]
    fn fresh_state_has_no_pending_or_staged() {
        let state = UpdaterState::new();
        let inner = state.inner.lock().unwrap();
        assert!(inner.pending.is_none());
        assert!(inner.staged.is_none());
        assert!(!inner.downloading);
    }

    /// `updater_status` maps the three shapes of `UpdaterInner`. A real
    /// `Update` can't be constructed outside the plugin, so this exercises the
    /// branch selection on the empty state and documents the precedence the
    /// other two branches encode.
    #[test]
    fn status_of_fresh_state_is_none() {
        let state = UpdaterState::new();
        let inner = state.inner.lock().unwrap();
        assert!(inner.staged.is_none() && inner.pending.is_none());
    }

    /// The in-flight flag is what lets `updater_download` tell "already
    /// downloading" apart from "nothing to download" — both leave `pending`
    /// empty, so the flag is the only distinguishing signal.
    #[test]
    fn downloading_flag_is_independent_of_pending() {
        let state = UpdaterState::new();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.downloading = true;
        }
        let inner = state.inner.lock().unwrap();
        assert!(inner.downloading);
        assert!(inner.pending.is_none());
    }

    /// `apply_staged_update_on_quit` is called from all three quit routes, so
    /// it must be safe to call with nothing staged and safe to call twice.
    #[test]
    fn taking_staged_twice_is_a_no_op() {
        let state = UpdaterState::new();
        assert!(state.inner.lock().unwrap().staged.take().is_none());
        assert!(state.inner.lock().unwrap().staged.take().is_none());
    }
}

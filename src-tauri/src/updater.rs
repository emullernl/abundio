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
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AbundioError;
use crate::workspace_store::WorkspaceStore;

/// Delay before the first auto-check so it stays off the launch critical path.
const INITIAL_CHECK_DELAY: Duration = Duration::from_secs(8);
/// Interval between background auto-checks for long-running sessions.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// The repository whose Releases hold the release notes. Never taken from the
/// frontend — `updater_release_notes` accepts no URL, only a validated version.
const GITHUB_REPO: &str = "emullernl/abundio";
/// One page of releases, newest first. Deliberately not paginated: see ADR-0036.
const RELEASES_PAGE_SIZE: usize = 30;
/// How long a fetched release list is reused. Matches GitHub's unauthenticated
/// budget of 60 requests per hour per IP — the Settings page fetches on every
/// mount, so without this a few visits would exhaust it.
const NOTES_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// Guards against a hung connection holding the What's new check open at launch.
const NOTES_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a *failed* fetch is remembered. Without this the rate-limited state
/// is the one state with no brake: every Settings mount, every Retry and every
/// "Check for updates" click would go straight back out to a GitHub that is
/// refusing us, spending the budget it is waiting for us to stop spending.
/// Short, so a user who reconnects is not locked out for long.
const NOTES_ERROR_TTL: Duration = Duration::from_secs(60);
/// Back-off when GitHub says we are rate-limited but gives no reset time.
const RATE_LIMIT_FALLBACK_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// Ceiling on a server-supplied back-off, so a bad `X-RateLimit-Reset` cannot
/// wedge the feature shut for the rest of the session.
const MAX_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(60 * 60);
/// `settings` key holding the newest version whose notes the user has seen.
const LAST_SEEN_VERSION_KEY: &str = "last_seen_version";

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

/// One published GitHub Release, reduced to what the app renders. See ADR-0036.
///
/// `version` has the tag's leading `v` stripped, so it compares directly against
/// the running version. `body` is raw Markdown — the frontend renders it through
/// the sanitizing Markdown pipeline, never as HTML.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub body: String,
    pub published_at: Option<String>,
    pub url: String,
}

/// One page of release notes, plus whether GitHub had more to give.
///
/// `has_more` is computed **before** filtering, because `parse_releases` drops
/// prereleases, drafts and non-semver tags — so a full page of 30 can arrive at
/// the frontend as a handful of entries. Without this the frontend cannot tell
/// "your version fell off the page" from "your version was never published",
/// and the anchoring rule would claim older releases exist that do not.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotesPage {
    pub releases: Vec<ReleaseNote>,
    pub has_more: bool,
}

/// The subset of GitHub's release JSON we read. Everything else is ignored, so
/// the API growing new fields cannot break the parse.
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
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
    /// Last successful release-notes fetch and when it landed. App-global, so
    /// the Settings page in one Window and the What's new check share one
    /// result rather than each spending a request. Behind an `Arc` because the
    /// What's new check only reads it, and copying 30 Markdown bodies to answer
    /// "which release am I on?" is pure waste. See ADR-0036.
    notes: Option<(Instant, Arc<ReleaseNotesPage>)>,
    /// Last *failed* fetch: when it happened, how long to honour it for, and
    /// what to say meanwhile. Separate from `notes` so a failure never evicts a
    /// good list. The duration is per-failure because a rate-limited response
    /// tells us when it lifts, while an offline one gets the short default.
    notes_error: Option<(Instant, Duration, String)>,
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

// ── Release notes (ADR-0036) ──

/// Splits a `major.minor.patch` string into its three numbers.
///
/// Deliberately strict rather than a full semver implementation:
/// `scripts/release.sh` refuses to tag anything that is not exactly three
/// numbers, so a tag with a suffix is not a release this app can be running.
fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// True when `a` is strictly newer than `b`. Unparseable versions are never
/// newer — a version we cannot read must not trigger a What's new card.
fn is_newer(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Turns GitHub's releases JSON into the list the frontend renders.
///
/// Drops prereleases (CI publishes with `prerelease: false` and the updater
/// resolves `releases/latest`, which skips them — listing one would advertise a
/// version the updater will never offer) and drafts (belt and braces: the
/// unauthenticated API does not return them, which is ADR-0014's publish-is-the-gate
/// rule enforced by GitHub). Tags that are not `vMAJOR.MINOR.PATCH` are skipped
/// rather than guessed at. Order is preserved: GitHub returns newest first.
fn parse_releases(json: &str) -> Result<ReleaseNotesPage, AbundioError> {
    let raw: Vec<GithubRelease> = serde_json::from_str(json).map_err(|e| {
        AbundioError::InvalidOperation(format!("could not read GitHub releases: {e}"))
    })?;
    // Counted before the filter: a full page means GitHub had at least this
    // many, whatever we then discard. See `ReleaseNotesPage::has_more`.
    let has_more = raw.len() >= RELEASES_PAGE_SIZE;
    let releases = raw
        .into_iter()
        .filter(|r| !r.prerelease && !r.draft)
        .filter_map(|r| {
            let version = r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name);
            parse_version(version)?;
            Some(ReleaseNote {
                version: version.to_string(),
                body: r.body.unwrap_or_default().trim().to_string(),
                published_at: r.published_at,
                url: r.html_url.unwrap_or_else(|| {
                    format!("https://github.com/{GITHUB_REPO}/releases/tag/{}", r.tag_name)
                }),
            })
        })
        .collect();
    Ok(ReleaseNotesPage {
        releases,
        has_more,
    })
}

/// Installs rustls' process-wide default crypto provider, once.
///
/// We build reqwest with `rustls-no-provider` to match what tauri-plugin-updater
/// already resolves, which keeps this off a second TLS stack — but that feature
/// means exactly what it says: rustls having its `ring` backend *compiled in* is
/// not the same as a provider being *installed*, and `Client::build()` panics
/// with "No provider set" when it goes looking. The updater plugin installs one
/// for its own client, so nothing is inherited here.
///
/// `install_default` returns `Err` when a provider is already set, which is a
/// success for our purposes — any provider will do.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Builds the HTTP client used for release notes.
///
/// Separate from `fetch_releases` so it can be tested without the network:
/// building the client is where the missing-provider panic lived.
fn build_client() -> Result<reqwest::Client, AbundioError> {
    ensure_crypto_provider();
    reqwest::Client::builder()
        .timeout(NOTES_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AbundioError::InvalidOperation(format!("http client: {e}")))
}

/// Fetches one page of published releases from GitHub.
///
/// Unauthenticated: these are public releases, and asking the user for a token
/// to read their own changelog would be absurd. That caps us at 60 requests per
/// hour per IP, which is what `NOTES_CACHE_TTL` is sized against.
async fn fetch_releases(app: &AppHandle) -> Result<ReleaseNotesPage, AbundioError> {
    let agent = format!("Abundio/{}", app.package_info().version);
    fetch_releases_as(&agent).await
}

/// How long GitHub wants us to wait, if this response says we are rate-limited.
///
/// `x-ratelimit-remaining: 0` is the signal (a 403 can mean other things), and
/// `x-ratelimit-reset` is a Unix timestamp. Clamped, because a clock skew or a
/// malformed header must not wedge release notes shut for the session.
fn rate_limit_backoff(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let header = |name: &str| headers.get(name)?.to_str().ok()?.parse::<u64>().ok();
    if header("x-ratelimit-remaining") != Some(0) {
        return None;
    }
    let Some(reset) = header("x-ratelimit-reset") else {
        return Some(RATE_LIMIT_FALLBACK_BACKOFF);
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let wait = Duration::from_secs(reset.saturating_sub(now));
    Some(wait.clamp(NOTES_ERROR_TTL, MAX_RATE_LIMIT_BACKOFF))
}

/// The network half, with no Tauri in it — so it can be exercised for real
/// against GitHub by the ignored test at the bottom of this file.
async fn fetch_releases_as(user_agent: &str) -> Result<ReleaseNotesPage, AbundioError> {
    let url = format!(
        "https://api.github.com/repos/{GITHUB_REPO}/releases?per_page={RELEASES_PAGE_SIZE}"
    );
    let client = build_client()?;
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        // GitHub rejects requests without one.
        .header("User-Agent", user_agent)
        .send()
        .await
        .map_err(|e| {
            AbundioError::InvalidOperation(format!("could not reach GitHub: {e}"))
        })?;
    if !response.status().is_success() {
        let status = response.status();
        // A rate-limited response carries how long to wait; honour it so the
        // negative cache backs off for exactly as long as GitHub wants.
        let backoff = rate_limit_backoff(response.headers());
        let message = format!("GitHub returned {status}");
        return Err(match backoff {
            Some(wait) => AbundioError::RateLimited { message, wait },
            None => AbundioError::InvalidOperation(message),
        });
    }
    let body = response.text().await.map_err(|e| {
        AbundioError::InvalidOperation(format!("could not read GitHub response: {e}"))
    })?;
    parse_releases(&body)
}

/// How long a cached failure should be honoured for.
fn error_backoff(err: &AbundioError) -> Duration {
    match err {
        AbundioError::RateLimited { wait, .. } => *wait,
        _ => NOTES_ERROR_TTL,
    }
}

/// Returns the cached release list, fetching when it is missing or stale.
///
/// `refresh` bypasses the *success* cache but deliberately **not** the failure
/// one. That is what makes the error branch's Retry honest: while GitHub is
/// refusing us, clicking Retry (or holding down "Check for updates") returns the
/// remembered failure instead of spending another request against the budget we
/// are waiting on. See ADR-0036.
///
/// The cache lock is never held across the network call. Two Windows opening
/// Settings at the same moment therefore each spend a request — the cache makes
/// repeat visits free, not concurrent first visits.
async fn releases_cached(
    app: &AppHandle,
    refresh: bool,
) -> Result<Arc<ReleaseNotesPage>, AbundioError> {
    if let Some(state) = app.try_state::<UpdaterState>() {
        let inner = state.inner.lock().unwrap();
        if let Some((failed_at, wait, message)) = inner.notes_error.as_ref() {
            if failed_at.elapsed() < *wait {
                return Err(AbundioError::InvalidOperation(message.clone()));
            }
        }
        if !refresh {
            if let Some((fetched_at, page)) = inner.notes.as_ref() {
                if fetched_at.elapsed() < NOTES_CACHE_TTL {
                    return Ok(page.clone());
                }
            }
        }
    }
    match fetch_releases(app).await {
        Ok(page) => {
            let page = Arc::new(page);
            if let Some(state) = app.try_state::<UpdaterState>() {
                let mut inner = state.inner.lock().unwrap();
                inner.notes = Some((Instant::now(), page.clone()));
                // A success clears the back-off, so a reconnecting user is not
                // held to the remainder of a stale one.
                inner.notes_error = None;
            }
            Ok(page)
        }
        Err(e) => {
            if let Some(state) = app.try_state::<UpdaterState>() {
                let mut inner = state.inner.lock().unwrap();
                inner.notes_error = Some((Instant::now(), error_backoff(&e), e.to_string()));
                // `notes` is deliberately left alone: a failed refresh must not
                // throw away a list that is already on screen.
            }
            Err(e)
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
        let _ = crate::window_management::emit_to_one_profile_window(
            app,
            "update-available",
            info,
        );
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

// ── What's new after an upgrade (ADR-0036) ──

/// Decides whether a version bump is worth a What's new card.
///
/// A fresh install (`last_seen` is `None`) is deliberately **not** a bump: the
/// user never upgraded from anything, so a changelog would be noise. A downgrade
/// is not one either, and it must not rewrite the flag — going back up to a
/// version already seen should stay quiet.
fn should_show_whats_new(running: &str, last_seen: Option<&str>) -> bool {
    match last_seen {
        None => false,
        Some(seen) => is_newer(running, seen),
    }
}

/// Runs the What's new check shortly after launch: compare the running version
/// against `last_seen_version`, fetch the notes, and emit `whats-new` to one
/// Window. See ADR-0036.
///
/// The flag advances **only** once notes were actually in hand, so an offline
/// launch shows nothing and tries again next time rather than silently
/// consuming the card. The one exception is a fetch that succeeded and found no
/// release for this version — a development build, or one still in draft. That
/// is an answer rather than a failure, so it marks the version seen; otherwise
/// every launch of a dev build would re-fetch forever.
pub fn start_whats_new_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_CHECK_DELAY).await;

        let running = app.package_info().version.to_string();
        let Some(store) = app.try_state::<WorkspaceStore>() else {
            return;
        };
        let last_seen = store.get_setting(LAST_SEEN_VERSION_KEY).ok().flatten();

        // Fresh install: record where we came in, and never show a card for it.
        if last_seen.is_none() {
            let _ = store.set_setting(LAST_SEEN_VERSION_KEY, &running);
            return;
        }
        if !should_show_whats_new(&running, last_seen.as_deref()) {
            return;
        }

        // Drop the state borrow before awaiting — `State` is not held across the
        // network call, and the store is re-borrowed afterwards.
        drop(store);

        let releases = match releases_cached(&app, false).await {
            Ok(releases) => releases,
            // Offline, rate-limited, or GitHub is down. Leave the flag alone so
            // a later launch still gets the card.
            Err(e) => {
                eprintln!("[abundio] what's new: could not fetch release notes: {e}");
                return;
            }
        };

        let Some(store) = app.try_state::<WorkspaceStore>() else {
            return;
        };
        match releases.releases.iter().find(|r| r.version == running) {
            Some(note) if !note.body.is_empty() => {
                let _ = crate::window_management::emit_to_one_profile_window(
                    &app,
                    "whats-new",
                    note.clone(),
                );
            }
            // Fetched successfully, but this version has no published notes.
            // Settled, not pending — mark it seen so we stop asking.
            _ => {
                let _ = store.set_setting(LAST_SEEN_VERSION_KEY, &running);
            }
        }
    });
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

/// Clears `UpdaterInner::downloading` however `updater_download` leaves — normal
/// return, `?`, panic, or the command future being dropped when its invoking
/// Window closes mid-download. Without this the flag latches `true` for the rest
/// of the process and every later download from every Window is refused with
/// "a download is already in progress", with no command able to reset it.
struct DownloadGuard<'a>(&'a Mutex<UpdaterInner>);

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.lock() {
            inner.downloading = false;
        }
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
    // Own the flag from here on — see `DownloadGuard`.
    let _guard = DownloadGuard(&state.inner);

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

    // The flag is cleared by `_guard` on every exit path. Put the update back as
    // `pending` on failure so a retry doesn't need a fresh check.
    let mut inner = state.inner.lock().unwrap();
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
    if let Err(e) = update.install(&bytes) {
        // Re-stage rather than dropping the bundle, exactly as
        // `apply_staged_update_on_quit` does. The macOS admin-authorisation
        // prompt is user-cancellable, and losing the download to a cancelled
        // dialog would force a full re-check and re-download.
        state.inner.lock().unwrap().staged = Some((update, bytes));
        return Err(AbundioError::InvalidOperation(format!(
            "update install failed: {e}"
        )));
    }
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

/// Returns the published release notes, newest first — one page, prereleases
/// dropped. `refresh` bypasses the hourly cache (the Settings "Check for
/// updates" button). Which of these entries the user actually sees is decided
/// frontend-side by `selectReleaseNotes`. See ADR-0036.
#[tauri::command]
pub async fn updater_release_notes(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<ReleaseNotesPage, AbundioError> {
    let page = releases_cached(&app, refresh.unwrap_or(false)).await?;
    // The one unavoidable copy: a command result has to be owned to serialize.
    // Everything upstream of here shares the `Arc`.
    Ok((*page).clone())
}

/// Marks the running version's notes as seen, so the What's new card does not
/// return on the next launch. Called when the card is dismissed.
#[tauri::command]
pub async fn updater_mark_version_seen(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
) -> Result<(), AbundioError> {
    let running = app.package_info().version.to_string();
    store.set_setting(LAST_SEEN_VERSION_KEY, &running)
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

    /// The guard is what makes the flag safe against a panic or a dropped
    /// (cancelled) command future — the paths that skip the normal reset.
    #[test]
    fn download_guard_clears_the_flag_on_drop() {
        let state = UpdaterState::new();
        state.inner.lock().unwrap().downloading = true;
        {
            let _guard = DownloadGuard(&state.inner);
        }
        assert!(!state.inner.lock().unwrap().downloading);
    }

    #[test]
    fn download_guard_clears_the_flag_while_unwinding() {
        let state = UpdaterState::new();
        state.inner.lock().unwrap().downloading = true;
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = DownloadGuard(&state.inner);
            panic!("download blew up");
        }));
        assert!(unwound.is_err());
        assert!(!state.inner.lock().unwrap().downloading);
    }

    /// `apply_staged_update_on_quit` is called from all three quit routes, so
    /// it must be safe to call with nothing staged and safe to call twice.
    #[test]
    fn taking_staged_twice_is_a_no_op() {
        let state = UpdaterState::new();
        assert!(state.inner.lock().unwrap().staged.take().is_none());
        assert!(state.inner.lock().unwrap().staged.take().is_none());
    }

    // ── Release notes (ADR-0036) ──

    #[test]
    fn parses_three_part_versions() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("0.0.0"), Some((0, 0, 0)));
        assert_eq!(parse_version("10.20.30"), Some((10, 20, 30)));
    }

    /// `scripts/release.sh` tags nothing but bare three-part versions, so
    /// anything else is not a release this app can be running.
    #[test]
    fn rejects_everything_that_is_not_three_numbers() {
        for bad in [
            "1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "", "abc", "1.2.x", "-1.2.3",
        ] {
            assert_eq!(parse_version(bad), None, "{bad} should not parse");
        }
        assert!(parse_version("1.2.3").is_some());
    }

    #[test]
    fn compares_versions_numerically_not_lexically() {
        // The case a string compare gets wrong.
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("1.2.3", "1.2.3"));
    }

    /// A version we cannot read must never look newer — it would fire a What's
    /// new card for a version whose notes we could not identify anyway.
    #[test]
    fn unparseable_versions_are_never_newer() {
        assert!(!is_newer("nightly", "0.1.0"));
        assert!(!is_newer("0.1.0", "nightly"));
    }

    /// Shorthand: the filtered list from a JSON page.
    fn parsed(json: &str) -> Vec<ReleaseNote> {
        parse_releases(json).unwrap().releases
    }

    #[test]
    fn parses_releases_newest_first_and_strips_the_v() {
        let json = r#"[
            {"tag_name":"v0.4.0","body":"newer","published_at":"2026-02-01T00:00:00Z","html_url":"https://example.test/4"},
            {"tag_name":"v0.3.0","body":"older","published_at":"2026-01-01T00:00:00Z","html_url":"https://example.test/3"}
        ]"#;
        let releases = parsed(json);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].version, "0.4.0");
        assert_eq!(releases[0].body, "newer");
        assert_eq!(releases[0].url, "https://example.test/4");
        assert_eq!(releases[1].version, "0.3.0");
    }

    /// The updater resolves `releases/latest`, which skips prereleases — listing
    /// one would advertise a version it will never offer.
    #[test]
    fn drops_prereleases_and_drafts() {
        let json = r#"[
            {"tag_name":"v0.5.0","body":"beta","prerelease":true},
            {"tag_name":"v0.4.0","body":"draft","draft":true},
            {"tag_name":"v0.3.0","body":"real"}
        ]"#;
        let releases = parsed(json);
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].version, "0.3.0");
    }

    #[test]
    fn skips_tags_that_are_not_versions() {
        let json = r#"[
            {"tag_name":"nightly","body":"x"},
            {"tag_name":"v1.0.0-rc1","body":"y"},
            {"tag_name":"v1.0.0","body":"z"}
        ]"#;
        let releases = parsed(json);
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].version, "1.0.0");
    }

    /// A release with no body is still a release — it is kept so the anchoring
    /// rule can find the running version, and the frontend words the empty case.
    #[test]
    fn keeps_releases_with_an_empty_body() {
        let releases = parsed(r#"[{"tag_name":"v1.0.0"}]"#);
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].body, "");
        assert_eq!(releases[0].published_at, None);
        assert_eq!(
            releases[0].url,
            "https://github.com/emullernl/abundio/releases/tag/v1.0.0"
        );
    }

    /// Unknown fields must not break the parse — GitHub adds them over time.
    #[test]
    fn ignores_unknown_fields() {
        let json = r#"[{"tag_name":"v1.0.0","body":"b","reactions":{"+1":3},"assets":[]}]"#;
        assert_eq!(parsed(json).len(), 1);
    }

    #[test]
    fn malformed_json_is_an_error_not_an_empty_list() {
        assert!(parse_releases("not json").is_err());
        assert!(parse_releases("{}").is_err());
    }

    // ── has_more: the discriminator the frontend anchors on ──

    /// Counted before filtering. A short page means GitHub had nothing more, so
    /// a running version missing from it was never published — as opposed to
    /// having fallen off a full page.
    #[test]
    fn a_short_page_reports_no_more() {
        let json = r#"[{"tag_name":"v1.0.0","body":"a"},{"tag_name":"v0.9.0","body":"b"}]"#;
        assert!(!parse_releases(json).unwrap().has_more);
    }

    #[test]
    fn a_full_page_reports_more() {
        let items: Vec<String> = (0..RELEASES_PAGE_SIZE)
            .map(|i| format!(r#"{{"tag_name":"v1.0.{i}","body":"x"}}"#))
            .collect();
        let json = format!("[{}]", items.join(","));
        let page = parse_releases(&json).unwrap();
        assert!(page.has_more);
        assert_eq!(page.releases.len(), RELEASES_PAGE_SIZE);
    }

    /// The case that makes counting-before-filtering load-bearing: a full page
    /// that filters down to almost nothing still means more exist.
    #[test]
    fn a_full_page_of_prereleases_still_reports_more() {
        let items: Vec<String> = (0..RELEASES_PAGE_SIZE)
            .map(|i| format!(r#"{{"tag_name":"v1.0.{i}","body":"x","prerelease":true}}"#))
            .collect();
        let json = format!("[{}]", items.join(","));
        let page = parse_releases(&json).unwrap();
        assert!(page.has_more);
        assert!(page.releases.is_empty());
    }

    #[test]
    fn an_empty_page_reports_no_more() {
        let page = parse_releases("[]").unwrap();
        assert!(!page.has_more);
        assert!(page.releases.is_empty());
    }

    // ── Negative cache back-off ──

    /// An ordinary failure (offline, 500) gets the short default.
    #[test]
    fn ordinary_failures_back_off_briefly() {
        let err = AbundioError::InvalidOperation("could not reach GitHub".into());
        assert_eq!(error_backoff(&err), NOTES_ERROR_TTL);
    }

    /// A rate-limited failure backs off for as long as GitHub asked.
    #[test]
    fn rate_limited_failures_back_off_for_as_long_as_asked() {
        let err = AbundioError::RateLimited {
            message: "GitHub returned 403".into(),
            wait: Duration::from_secs(900),
        };
        assert_eq!(error_backoff(&err), Duration::from_secs(900));
    }

    fn headers(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
        let mut map = reqwest::header::HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        map
    }

    /// A 403 is not automatically a rate limit — `remaining: 0` is the signal.
    #[test]
    fn no_backoff_when_requests_remain() {
        assert_eq!(
            rate_limit_backoff(&headers(&[("x-ratelimit-remaining", "57")])),
            None
        );
        assert_eq!(rate_limit_backoff(&headers(&[])), None);
    }

    #[test]
    fn backs_off_until_the_reset_time() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let reset = (now + 600).to_string();
        let wait = rate_limit_backoff(&headers(&[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", &reset),
        ]))
        .unwrap();
        assert!(wait > Duration::from_secs(540) && wait <= Duration::from_secs(600));
    }

    /// Rate-limited with no reset header: fall back rather than hammering.
    #[test]
    fn backs_off_by_default_when_no_reset_is_given() {
        assert_eq!(
            rate_limit_backoff(&headers(&[("x-ratelimit-remaining", "0")])),
            Some(RATE_LIMIT_FALLBACK_BACKOFF)
        );
    }

    /// A reset in the past (clock skew) must still back off a little, and an
    /// absurd one must not wedge the feature shut.
    #[test]
    fn clamps_a_nonsensical_reset_time() {
        let past = rate_limit_backoff(&headers(&[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", "1"),
        ]))
        .unwrap();
        assert_eq!(past, NOTES_ERROR_TTL);

        let absurd = rate_limit_backoff(&headers(&[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", "99999999999"),
        ]))
        .unwrap();
        assert_eq!(absurd, MAX_RATE_LIMIT_BACKOFF);
    }

    #[test]
    fn ignores_unparseable_rate_limit_headers() {
        assert_eq!(
            rate_limit_backoff(&headers(&[("x-ratelimit-remaining", "lots")])),
            None
        );
    }

    /// Regression test for a panic, not a failure: reqwest is built with
    /// `rustls-no-provider`, and without an installed provider `build()` panics
    /// with "No provider set" — which took down the tokio worker and left the
    /// Settings page on "Loading…" forever, since the command never replied.
    #[test]
    fn builds_an_https_client_without_panicking() {
        assert!(build_client().is_ok());
    }

    /// The provider install must tolerate being called repeatedly, and must
    /// tolerate another component (tauri-plugin-updater) having got there first.
    #[test]
    fn installing_the_crypto_provider_is_idempotent() {
        ensure_crypto_provider();
        ensure_crypto_provider();
        assert!(build_client().is_ok());
    }

    /// Hits the real GitHub API. Ignored by default so the suite stays offline
    /// and off the 60-per-hour rate limit; run it deliberately with
    /// `cargo test -- --ignored live_github`. It is the test that would have
    /// caught the missing crypto provider, which no fixture-based test could:
    /// the panic was in building the client, not in anything we parse.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn live_github_release_notes_fetch() {
        let page = fetch_releases_as("Abundio/test").await.unwrap();
        assert!(!page.releases.is_empty(), "expected published releases");
        for r in &page.releases {
            assert!(parse_version(&r.version).is_some(), "bad version {}", r.version);
            assert!(r.url.starts_with("https://github.com/"), "bad url {}", r.url);
        }
    }

    // ── What's new gate ──

    /// A fresh install never upgraded from anything, so it gets no card — the
    /// caller seeds the flag instead.
    #[test]
    fn fresh_install_shows_no_whats_new() {
        assert!(!should_show_whats_new("0.4.0", None));
    }

    #[test]
    fn upgrade_shows_whats_new() {
        assert!(should_show_whats_new("0.4.0", Some("0.3.0")));
        assert!(should_show_whats_new("0.10.0", Some("0.9.0")));
    }

    #[test]
    fn same_version_shows_nothing() {
        assert!(!should_show_whats_new("0.4.0", Some("0.4.0")));
    }

    /// Going back down must stay quiet — and must not rewrite the flag, or
    /// returning to the newer version would show its card a second time.
    #[test]
    fn downgrade_shows_nothing() {
        assert!(!should_show_whats_new("0.3.0", Some("0.4.0")));
    }
}

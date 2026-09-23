//! App-global GitHub PR poller. See ADR-0019.
//!
//! Runs **once for the whole application** (not per Window). On a focus-adaptive
//! cadence it makes a single `gh api graphql` call (both PR lists, with CI +
//! approval status), then:
//!   - broadcasts the full lists as `pr-state` to every Window (display data);
//!   - diffs against the previous payload and emits `pr-changes` to **one**
//!     profile-bound Window (the focused one, else any) so N Windows don't each
//!     fire duplicate OS notifications — mirroring the updater's single-target
//!     pattern.
//!
//! Cadence: the user-configured interval (default 5 min, 1–30) while any Window
//! is frontmost, else a fixed 1 hour. "Off" disables timer + focus fetches; the
//! manual Refresh command still does a one-shot fetch (bypasses both).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::error::AbundioError;
use crate::gh_commands::{self, PullRequest};

/// Delay before the first poll so it stays off the launch critical path.
const INITIAL_DELAY: Duration = Duration::from_secs(2);
/// Fixed cadence while the app is backgrounded (no Window focused).
const BACKGROUND_INTERVAL_MINS: u32 = 60;
/// Default focused cadence; mirrors the frontend setting default.
const DEFAULT_INTERVAL_MINS: u32 = 5;

// ── Event payloads (frontend-bound, camelCase) ──

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrStatePayload {
	pub available: bool,
	pub authenticated: bool,
	pub review_requested: Vec<PullRequest>,
	pub mine: Vec<PullRequest>,
	pub error: Option<String>,
	/// Why the unread markers couldn't be fetched (e.g. a fine-grained token
	/// with no notifications access). The PR lists are still good; the panel
	/// shows a quiet note instead of letting "no markers" pass as "all read".
	pub unread_error: Option<String>,
}

/// A single notification-worthy change, with a preformatted `body`. The
/// receiving Window adds the profile-aware title and workspace-routing payload.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrChange {
	pub kind: String,
	pub body: String,
}

// ── Shared state (cloned into the background task) ──

#[derive(Clone)]
struct PollerShared {
	interval_minutes: Arc<AtomicU32>,
	enabled: Arc<AtomicBool>,
	notify: Arc<Notify>,
	/// Set by manual refresh — forces a fetch this iteration (ignores
	/// `enabled` and the min-gap).
	force_fetch: Arc<AtomicBool>,
	/// Set on window focus-gain — fetches only if `enabled` and the min-gap
	/// (= the focused interval) has elapsed.
	focus_pending: Arc<AtomicBool>,
	last: Arc<Mutex<Option<PrStatePayload>>>,
	/// Last *successful* (authenticated, error-free) payload — the notification
	/// diff baseline, kept separate from `last` so a transient gh error (whose
	/// lists are empty) doesn't reset the baseline and swallow the next success's
	/// notifications.
	last_success: Arc<Mutex<Option<PrStatePayload>>>,
	last_fetch: Arc<Mutex<Option<Instant>>>,
}

pub struct PrPoller {
	shared: PollerShared,
}

impl Default for PrPoller {
	fn default() -> Self {
		Self::new()
	}
}

impl PrPoller {
	pub fn new() -> Self {
		Self {
			shared: PollerShared {
				interval_minutes: Arc::new(AtomicU32::new(DEFAULT_INTERVAL_MINS)),
				// Off until the frontend pushes the persisted setting (mirrors
				// UpdaterState::auto_check, updater.rs). This guarantees the
				// PR's "zero when Off" promise with no startup race — the poller
				// never fetches before it knows the user's real config.
				enabled: Arc::new(AtomicBool::new(false)),
				notify: Arc::new(Notify::new()),
				force_fetch: Arc::new(AtomicBool::new(false)),
				focus_pending: Arc::new(AtomicBool::new(false)),
				last: Arc::new(Mutex::new(None)),
				last_success: Arc::new(Mutex::new(None)),
				last_fetch: Arc::new(Mutex::new(None)),
			},
		}
	}

	/// Push the persisted frontend setting. Clamps the interval to 1–30 and
	/// wakes the loop so the new cadence / enabled-state takes effect now.
	pub fn set_config(&self, enabled: bool, minutes: u32) {
		let was_enabled = self.shared.enabled.swap(enabled, Ordering::Relaxed);
		self.shared
			.interval_minutes
			.store(minutes.clamp(1, 30), Ordering::Relaxed);
		// Just turned on (including the frontend's first push at startup) →
		// populate immediately instead of waiting for the first timer tick. A
		// redundant push from another Window (already on) does not refetch.
		if enabled && !was_enabled {
			self.shared.force_fetch.store(true, Ordering::Relaxed);
		}
		self.shared.notify.notify_one();
	}

	/// Manual Refresh: force an immediate one-shot fetch regardless of
	/// `enabled` or the min-gap.
	pub fn request_refresh(&self) {
		self.shared.force_fetch.store(true, Ordering::Relaxed);
		self.shared.notify.notify_one();
	}

	/// Window focus-gain: maybe fetch (gated by `enabled` + min-gap in the loop).
	pub fn on_focus(&self) {
		self.shared.focus_pending.store(true, Ordering::Relaxed);
		self.shared.notify.notify_one();
	}

	/// Clear `thread_id`'s unread marker from both cached payloads. Returns
	/// whether any cached PR carried it — in either cache, so the caller's
	/// broadcast can never be skipped after a cache was mutated.
	///
	/// `last` is what new Windows' snapshots serve, so it must be cleared.
	/// Clearing `last_success` too is only so the notification baseline can't
	/// disagree with `last` if `diff_changes` ever grows to look at this field;
	/// today nothing observes it there.
	pub fn clear_unread(&self, thread_id: &str) -> bool {
		let in_baseline = self
			.shared
			.last_success
			.lock()
			.unwrap()
			.as_mut()
			.is_some_and(|p| clear_unread_in(p, thread_id));
		let in_last = self
			.shared
			.last
			.lock()
			.unwrap()
			.as_mut()
			.is_some_and(|p| clear_unread_in(p, thread_id));
		in_baseline || in_last
	}

	/// Last emitted payload, for new Windows to hydrate from without a gh call.
	pub fn snapshot(&self) -> Option<PrStatePayload> {
		self.shared.last.lock().unwrap().clone()
	}

	fn shared(&self) -> PollerShared {
		self.shared.clone()
	}
}

/// Returns whether any PR in `payload` carried `thread_id`.
fn clear_unread_in(payload: &mut PrStatePayload, thread_id: &str) -> bool {
	let mut hit = false;
	for pr in payload.review_requested.iter_mut().chain(payload.mine.iter_mut()) {
		if pr.unread_thread_id.as_deref() == Some(thread_id) {
			pr.unread_thread_id = None;
			hit = true;
		}
	}
	hit
}

/// True if any Abundio Window is frontmost (Settings included).
fn app_focused(app: &AppHandle) -> bool {
	app.webview_windows()
		.values()
		.any(|w| w.is_focused().unwrap_or(false))
}

/// Min-gap clock: has at least `interval_mins` elapsed since the last fetch?
fn gap_elapsed(shared: &PollerShared, interval_mins: u32) -> bool {
	match *shared.last_fetch.lock().unwrap() {
		Some(t) => t.elapsed() >= Duration::from_secs(interval_mins as u64 * 60),
		None => true,
	}
}

/// Blocking: probe availability/auth (cached) and, if good, run the combined
/// query. Always returns a payload (errors are carried, not propagated).
fn build_payload_blocking() -> PrStatePayload {
	let (available, authenticated) = gh_commands::gh_available_and_authenticated();
	if !available || !authenticated {
		return PrStatePayload {
			available,
			authenticated,
			..Default::default()
		};
	}
	match gh_commands::fetch_prs() {
		Ok((mut review_requested, mut mine)) => {
			// A failure here costs only the markers, never the lists. With no
			// PRs to mark, `unread_since` is None and the call is skipped.
			let unread = match gh_commands::unread_since(review_requested.iter().chain(&mine)) {
				Some(since) => gh_commands::fetch_unread_pr_threads(&since),
				None => Ok(Default::default()),
			};
			let unread_error = match unread {
				Ok(threads) => {
					gh_commands::apply_unread(&mut review_requested, &threads);
					gh_commands::apply_unread(&mut mine, &threads);
					None
				}
				Err(e) => Some(pr_error_message(e)),
			};
			PrStatePayload {
				available: true,
				authenticated: true,
				review_requested,
				mine,
				error: None,
				unread_error,
			}
		}
		Err(e) => PrStatePayload {
			available: true,
			authenticated: true,
			error: Some(pr_error_message(e)),
			..Default::default()
		},
	}
}

/// User-facing text for a PR-fetch failure. `fetch_prs` only ever yields
/// `AbundioError::Git`, whose `Display` prepends a technical "Git error: " —
/// strip it so the friendly messages built in `gh_commands` (offline /
/// unparseable response) read cleanly in the panel.
fn pr_error_message(e: AbundioError) -> String {
	match e {
		AbundioError::Git(msg) => msg,
		other => other.to_string(),
	}
}

/// Diff the previous payload against the new one into notification descriptors.
/// Mirrors the prior JS logic: brand-new review requests, and `reviewDecision` /
/// `statusCheckRollup` transitions on PRs the user already had open.
fn diff_changes(prev: &PrStatePayload, next: &PrStatePayload) -> Vec<PrChange> {
	let mut out = Vec::new();

	let prev_review: HashSet<(String, i32)> = prev
		.review_requested
		.iter()
		.map(|p| (p.repository.clone(), p.number))
		.collect();
	for pr in &next.review_requested {
		if !prev_review.contains(&(pr.repository.clone(), pr.number)) {
			out.push(PrChange {
				kind: "review-requested".to_string(),
				body: format!("Review requested: {} (#{})", pr.title, pr.number),
			});
		}
	}

	let prev_mine: HashMap<(String, i32), &PullRequest> = prev
		.mine
		.iter()
		.map(|p| ((p.repository.clone(), p.number), p))
		.collect();
	for pr in &next.mine {
		let Some(before) = prev_mine.get(&(pr.repository.clone(), pr.number)) else {
			continue; // brand-new own PR — not notified (matches prior behaviour)
		};
		if before.review_decision != pr.review_decision && !pr.review_decision.is_empty() {
			let label = match pr.review_decision.as_str() {
				"APPROVED" => "approved".to_string(),
				"CHANGES_REQUESTED" => "has changes requested".to_string(),
				other => format!("review: {}", other.to_lowercase()),
			};
			out.push(PrChange {
				kind: "review".to_string(),
				body: format!("#{} {} — {}", pr.number, pr.title, label),
			});
		}
		if before.status_check_rollup != pr.status_check_rollup && !pr.status_check_rollup.is_empty()
		{
			let label = match pr.status_check_rollup.as_str() {
				"SUCCESS" => "CI passed".to_string(),
				"FAILURE" => "CI failed".to_string(),
				other => format!("CI: {}", other.to_lowercase()),
			};
			out.push(PrChange {
				kind: "ci".to_string(),
				body: format!("#{} {} — {}", pr.number, pr.title, label),
			});
		}
	}

	out
}

/// Broadcast `pr-state` to all Windows; diff and send `pr-changes` to one
/// profile Window; then cache the payload.
fn emit_payload(app: &AppHandle, shared: &PollerShared, payload: PrStatePayload) {
	// Broadcast the display data to every Window.
	let _ = app.emit("pr-state", &payload);

	let is_success = payload.authenticated && payload.error.is_none();

	// Diff against the last *successful* payload — not merely the last emitted
	// one. This both skips the unauth→auth transition (which would flag every PR
	// as "new" and spam on first login) and survives a transient error round:
	// the error payload never becomes the baseline, so the next success still
	// diffs against real prior data instead of an empty error payload.
	if is_success {
		if let Some(prev) = shared.last_success.lock().unwrap().clone() {
			let changes = diff_changes(&prev, &payload);
			if !changes.is_empty() {
				// Exactly one Window, so N Windows don't each fire duplicate
				// OS notifications.
				let _ = crate::window_management::emit_to_one_profile_window(
					app,
					"pr-changes",
					&changes,
				);
			}
		}
	}

	// `last` is the snapshot served to new Windows (reflects the latest
	// broadcast, error or not); `last_success` is the notification baseline.
	*shared.last.lock().unwrap() = Some(payload.clone());
	if is_success {
		*shared.last_success.lock().unwrap() = Some(payload);
	}
}

/// Spawn the single app-global poll loop. Called once from `lib.rs` setup.
pub fn start(app: AppHandle) {
	let shared = match app.try_state::<PrPoller>() {
		Some(p) => p.shared(),
		None => return,
	};
	tauri::async_runtime::spawn(async move {
		tokio::time::sleep(INITIAL_DELAY).await;
		// Whether the previous wait ended because the cadence timer elapsed (vs a
		// notify for refresh / focus / config change). Starts false so the first
		// iteration never fetches on its own — the frontend's config push (or a
		// manual refresh) drives the initial fetch via `force_fetch`.
		let mut timer_elapsed = false;
		loop {
			let force = shared.force_fetch.swap(false, Ordering::Relaxed);
			let focus = shared.focus_pending.swap(false, Ordering::Relaxed);
			let enabled = shared.enabled.load(Ordering::Relaxed);
			let interval = shared.interval_minutes.load(Ordering::Relaxed);

			// Fetch only for explicit reasons: a manual refresh, the cadence timer
			// firing, or a focus-gain past the min-gap. A bare notify (interval
			// change, or a redundant config push from another Window) just
			// recomputes the wait — it never fetches.
			let should_fetch = force
				|| (timer_elapsed && enabled)
				|| (focus && enabled && gap_elapsed(&shared, interval));

			if should_fetch {
				let payload = tokio::task::spawn_blocking(build_payload_blocking)
					.await
					.unwrap_or_else(|_| PrStatePayload {
						error: Some("pr poll task panicked".to_string()),
						..Default::default()
					});
				emit_payload(&app, &shared, payload);
				// Stamp AFTER completion so the min-gap measures spacing between
				// finished fetches, not from fetch start.
				*shared.last_fetch.lock().unwrap() = Some(Instant::now());
			}

			let mins = if app_focused(&app) {
				shared.interval_minutes.load(Ordering::Relaxed)
			} else {
				BACKGROUND_INTERVAL_MINS
			};
			let dur = Duration::from_secs(mins as u64 * 60);
			timer_elapsed = tokio::select! {
				_ = tokio::time::sleep(dur) => true,
				_ = shared.notify.notified() => false,
			};
		}
	});
}

// ── Tauri commands ──

#[tauri::command]
pub async fn pr_poller_set_config(
	poller: State<'_, PrPoller>,
	enabled: bool,
	minutes: u32,
) -> Result<(), AbundioError> {
	poller.set_config(enabled, minutes);
	Ok(())
}

#[tauri::command]
pub async fn pr_poller_refresh(poller: State<'_, PrPoller>) -> Result<(), AbundioError> {
	gh_commands::invalidate_gh_auth_cache();
	poller.request_refresh();
	Ok(())
}

/// Mark a PR's notification thread read: clear the marker in the cache (so
/// new Windows' snapshots agree) and in every Window at once, then tell
/// GitHub. A failed PATCH is returned, and the next poll brings it back.
///
/// Windows hear a narrow `pr-unread-cleared`, not a `pr-state` rebroadcast:
/// `pr-state` means "a poll finished" to its receivers, which stop the
/// Refresh spinner on it — so a rebroadcast would stop it mid-fetch.
#[tauri::command]
pub async fn pr_mark_read(
	app: AppHandle,
	poller: State<'_, PrPoller>,
	thread_id: String,
) -> Result<(), AbundioError> {
	if poller.clear_unread(&thread_id) {
		let _ = app.emit("pr-unread-cleared", &thread_id);
	}
	tokio::task::spawn_blocking(move || gh_commands::mark_thread_read(&thread_id))
		.await
		.map_err(|e| AbundioError::InvalidOperation(format!("mark-read task failed: {}", e)))?
}

#[tauri::command]
pub async fn pr_poller_snapshot(
	poller: State<'_, PrPoller>,
) -> Result<Option<PrStatePayload>, AbundioError> {
	Ok(poller.snapshot())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn pr(repo: &str, number: i32, review: &str, ci: &str) -> PullRequest {
		PullRequest {
			number,
			title: format!("PR {}", number),
			repository: repo.to_string(),
			review_decision: review.to_string(),
			status_check_rollup: ci.to_string(),
			..Default::default()
		}
	}

	fn payload(review: Vec<PullRequest>, mine: Vec<PullRequest>) -> PrStatePayload {
		PrStatePayload {
			available: true,
			authenticated: true,
			review_requested: review,
			mine,
			error: None,
			unread_error: None,
		}
	}

	#[test]
	fn diff_flags_new_review_request() {
		let prev = payload(vec![], vec![]);
		let next = payload(vec![pr("org/repo", 7, "", "")], vec![]);
		let changes = diff_changes(&prev, &next);
		assert_eq!(changes.len(), 1);
		assert_eq!(changes[0].kind, "review-requested");
		assert!(changes[0].body.contains("#7"));
	}

	#[test]
	fn diff_ignores_existing_review_request() {
		let prev = payload(vec![pr("org/repo", 7, "", "")], vec![]);
		let next = payload(vec![pr("org/repo", 7, "", "")], vec![]);
		assert!(diff_changes(&prev, &next).is_empty());
	}

	#[test]
	fn diff_flags_review_decision_and_ci_transitions() {
		let prev = payload(vec![], vec![pr("org/repo", 9, "", "PENDING")]);
		let next = payload(vec![], vec![pr("org/repo", 9, "APPROVED", "SUCCESS")]);
		let changes = diff_changes(&prev, &next);
		assert_eq!(changes.len(), 2);
		assert!(changes.iter().any(|c| c.kind == "review" && c.body.contains("approved")));
		assert!(changes.iter().any(|c| c.kind == "ci" && c.body.contains("CI passed")));
	}

	#[test]
	fn diff_skips_brand_new_own_pr() {
		let prev = payload(vec![], vec![]);
		let next = payload(vec![], vec![pr("org/repo", 9, "APPROVED", "SUCCESS")]);
		// A brand-new own PR is not notified (no prior state to transition from).
		assert!(diff_changes(&prev, &next).is_empty());
	}

	#[test]
	fn pr_error_message_strips_git_prefix() {
		// The friendly gh messages must reach the panel without the technical
		// "Git error: " prefix that AbundioError::Git's Display adds.
		let e = AbundioError::Git("Can't reach GitHub — check your internet connection.".into());
		assert_eq!(
			pr_error_message(e),
			"Can't reach GitHub — check your internet connection."
		);
	}

	#[test]
	fn gap_elapsed_true_when_never_fetched() {
		let poller = PrPoller::new();
		assert!(gap_elapsed(&poller.shared, 5));
	}

	#[test]
	fn gap_elapsed_false_right_after_fetch() {
		let poller = PrPoller::new();
		*poller.shared.last_fetch.lock().unwrap() = Some(Instant::now());
		assert!(!gap_elapsed(&poller.shared, 5));
	}

	#[test]
	fn clear_unread_updates_both_caches_and_both_lists() {
		let poller = PrPoller::new();
		let mut a = pr("org/repo", 1, "", "");
		a.unread_thread_id = Some("55".into());
		let mut b = pr("org/repo", 2, "", "");
		b.unread_thread_id = Some("66".into());
		let p = payload(vec![a], vec![b]);
		*poller.shared.last.lock().unwrap() = Some(p.clone());
		*poller.shared.last_success.lock().unwrap() = Some(p);

		assert!(poller.clear_unread("55"), "thread 55 was cached");
		let out = poller.snapshot().unwrap();
		assert_eq!(out.review_requested[0].unread_thread_id, None);
		assert_eq!(out.mine[0].unread_thread_id.as_deref(), Some("66"));
		let baseline = poller.shared.last_success.lock().unwrap().clone().unwrap();
		assert_eq!(baseline.review_requested[0].unread_thread_id, None);
	}

	#[test]
	fn clear_unread_unknown_thread_is_false() {
		let poller = PrPoller::new();
		assert!(!poller.clear_unread("1"), "nothing cached");
		*poller.shared.last.lock().unwrap() = Some(payload(vec![], vec![]));
		assert!(!poller.clear_unread("1"), "no PR carries it");
	}

	#[test]
	fn clear_unread_reports_a_hit_in_the_baseline_alone() {
		// Symmetric by construction: if only `last_success` held the thread,
		// the caller must still broadcast.
		let poller = PrPoller::new();
		let mut a = pr("org/repo", 1, "", "");
		a.unread_thread_id = Some("55".into());
		*poller.shared.last_success.lock().unwrap() = Some(payload(vec![a], vec![]));
		assert!(poller.clear_unread("55"));
	}
}

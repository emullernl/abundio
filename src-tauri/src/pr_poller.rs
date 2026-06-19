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
				enabled: Arc::new(AtomicBool::new(true)),
				notify: Arc::new(Notify::new()),
				force_fetch: Arc::new(AtomicBool::new(false)),
				focus_pending: Arc::new(AtomicBool::new(false)),
				last: Arc::new(Mutex::new(None)),
				last_fetch: Arc::new(Mutex::new(None)),
			},
		}
	}

	/// Push the persisted frontend setting. Clamps the interval to 1–30 and
	/// wakes the loop so the new cadence / enabled-state takes effect now.
	pub fn set_config(&self, enabled: bool, minutes: u32) {
		self.shared.enabled.store(enabled, Ordering::Relaxed);
		self.shared
			.interval_minutes
			.store(minutes.clamp(1, 30), Ordering::Relaxed);
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

	/// Last emitted payload, for new Windows to hydrate from without a gh call.
	pub fn snapshot(&self) -> Option<PrStatePayload> {
		self.shared.last.lock().unwrap().clone()
	}

	fn shared(&self) -> PollerShared {
		self.shared.clone()
	}
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
		Ok((review_requested, mine)) => PrStatePayload {
			available: true,
			authenticated: true,
			review_requested,
			mine,
			error: None,
		},
		Err(e) => PrStatePayload {
			available: true,
			authenticated: true,
			error: Some(format!("{}", e)),
			..Default::default()
		},
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
	let prev = shared.last.lock().unwrap().clone();

	let _ = app.emit("pr-state", &payload);

	// Only diff between two successful, authenticated fetches — this skips the
	// unauth→auth transition (e.g. after `gh auth login`), which would
	// otherwise flag every PR as "new" and spam notifications on first load.
	if let Some(prev) = prev {
		if prev.authenticated
			&& prev.error.is_none()
			&& payload.authenticated
			&& payload.error.is_none()
		{
			let changes = diff_changes(&prev, &payload);
			if !changes.is_empty() {
				emit_changes_to_one_window(app, &changes);
			}
		}
	}

	*shared.last.lock().unwrap() = Some(payload);
}

/// Send `pr-changes` to the focused profile Window, else any profile Window.
/// Mirrors `updater::emit_update_available` so notifications fire exactly once.
fn emit_changes_to_one_window(app: &AppHandle, changes: &[PrChange]) {
	let windows = app.webview_windows();
	let focused = windows.iter().find_map(|(label, w)| {
		(w.is_focused().unwrap_or(false)
			&& crate::window_management::is_profile_window_label(label))
		.then(|| label.clone())
	});
	let target = focused.or_else(|| {
		windows
			.keys()
			.find(|label| crate::window_management::is_profile_window_label(label))
			.cloned()
	});
	if let Some(label) = target {
		let _ = app.emit_to(label.as_str(), "pr-changes", changes);
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
		loop {
			let force = shared.force_fetch.swap(false, Ordering::Relaxed);
			let focus = shared.focus_pending.swap(false, Ordering::Relaxed);
			let enabled = shared.enabled.load(Ordering::Relaxed);
			let interval = shared.interval_minutes.load(Ordering::Relaxed);

			let should_fetch = if force {
				true
			} else if focus {
				enabled && gap_elapsed(&shared, interval)
			} else {
				// timer-elapsed (or the first iteration)
				enabled
			};

			if should_fetch {
				*shared.last_fetch.lock().unwrap() = Some(Instant::now());
				let payload = tokio::task::spawn_blocking(build_payload_blocking)
					.await
					.unwrap_or_else(|_| PrStatePayload {
						error: Some("pr poll task panicked".to_string()),
						..Default::default()
					});
				emit_payload(&app, &shared, payload);
			}

			let mins = if app_focused(&app) {
				shared.interval_minutes.load(Ordering::Relaxed)
			} else {
				BACKGROUND_INTERVAL_MINS
			};
			let dur = Duration::from_secs(mins as u64 * 60);
			tokio::select! {
				_ = tokio::time::sleep(dur) => {}
				_ = shared.notify.notified() => {}
			}
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
}

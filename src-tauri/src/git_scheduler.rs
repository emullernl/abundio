/// Per-workspace git refresh, Rust-initiated and pushed to JS via `git-state-<workspaceId>`.
///
/// Why this exists: WKWebView's `invoke()` mechanism has measured ~100-600ms of
/// JS main-thread interference for every in-flight IPC call, regardless of how
/// trivial the Rust work is. Repeated `invoke()`s on every `git stash` froze
/// terminal typing for ~2s. Solution: stop using `invoke()` on the high-frequency
/// path. The scheduler watches the existing `fs-change` / `git-change` events
/// (the same ones `file_watcher.rs` already emits), recomputes the bundle in
/// the background, and emits `git-state-<workspaceId>` — a one-way push that
/// does not block the JS main thread the way `invoke` does.
///
/// Lifecycle: started by `git_scheduler_start` (called from the frontend on
/// workspace open), stopped by `git_scheduler_stop` (on workspace close).
/// A baseBranch change is handled by stop+start with the new value — keeps
/// the per-workspace state immutable for its lifetime, avoiding the need for
/// internal mutex/setter complexity.
use crossbeam_channel::{bounded, Receiver, Sender};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener};

use crate::error::AbundioError;
use crate::git_commands::{
    compute_branch_info_sync, compute_changed_files_sync, compute_status_fingerprint_sync,
    GitFetchBundle,
};

/// Minimal deserializer for the existing `fs-change` / `git-change` event
/// payloads — we only need the `root` field to filter. The full payloads
/// are defined in `events.rs` as `Serialize`-only (frontend-bound); rather
/// than retrofit `Deserialize` onto them just for this listener, decode just
/// the field we use.
#[derive(Deserialize)]
struct RootOnly {
    root: String,
}

/// Pushed to the frontend on every refresh — success or failure.
///
/// Single discriminated channel (rather than separate success/error events)
/// so the frontend has one ordered stream of state. The `notGitRepo` flag
/// mirrors the regex match in the existing `fetchChanges` catch path.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum GitStateEvent {
    Bundle { bundle: GitFetchBundle },
    Error { message: String, not_git_repo: bool },
}

struct SchedulerEntry {
    stop_tx: Sender<()>,
}

impl Drop for SchedulerEntry {
    fn drop(&mut self) {
        // Signals the worker to exit on its next iteration; the worker
        // unlistens its `fs-change`/`git-change` subscriptions before exiting.
        let _ = self.stop_tx.send(());
    }
}

pub struct GitScheduler {
    entries: DashMap<String, SchedulerEntry>,
}

impl GitScheduler {
    pub fn new() -> Self {
        Self {
            entries: DashMap::new(),
        }
    }

    /// Spawn a per-workspace worker. Idempotent — calling `start` twice for
    /// the same `workspace_id` is a no-op (matches `FileWatcher::start_watching`).
    /// To change `base_branch`, call `stop` then `start` again.
    pub fn start(
        &self,
        app: AppHandle,
        workspace_id: String,
        root_path: String,
        base_branch: Option<String>,
    ) {
        use dashmap::mapref::entry::Entry;
        let vacant = match self.entries.entry(workspace_id.clone()) {
            Entry::Occupied(_) => return,
            Entry::Vacant(v) => v,
        };

        // Capacity-1 channel = automatic coalescing. If the worker is busy
        // when many triggers arrive, only one is enqueued; the rest fall on
        // the floor via `try_send`. The worker drains any remaining one
        // after its compute finishes, so no real change is ever lost.
        let (trigger_tx, trigger_rx) = bounded::<()>(1);
        let (stop_tx, stop_rx) = bounded::<()>(1);

        // Subscribe to the file watcher's existing events. We filter by
        // `root_path` in the payload (same pattern the frontend's `onFsChange`
        // / `onGitChange` use). Loose coupling: `file_watcher.rs` does not
        // know the scheduler exists.
        let trigger_for_fs = trigger_tx.clone();
        let root_for_fs = root_path.clone();
        let fs_listen_id = app.listen("fs-change", move |event| {
            if let Ok(payload) = serde_json::from_str::<RootOnly>(event.payload()) {
                if payload.root == root_for_fs {
                    let _ = trigger_for_fs.try_send(());
                }
            }
        });

        let trigger_for_git = trigger_tx.clone();
        let root_for_git = root_path.clone();
        let git_listen_id = app.listen("git-change", move |event| {
            if let Ok(payload) = serde_json::from_str::<RootOnly>(event.payload()) {
                if payload.root == root_for_git {
                    let _ = trigger_for_git.try_send(());
                }
            }
        });

        // Fire an initial trigger so the frontend has data immediately on
        // workspace open — no extra `invoke` from JS needed.
        let _ = trigger_tx.try_send(());

        // Worker thread. Owns its base_branch (immutable for its lifetime —
        // restarts on baseBranch change). On exit, unlistens both subscriptions.
        let app_for_worker = app.clone();
        std::thread::spawn(move || {
            worker_loop(
                &workspace_id,
                &root_path,
                base_branch,
                &app_for_worker,
                &trigger_rx,
                &stop_rx,
            );
            app_for_worker.unlisten(fs_listen_id);
            app_for_worker.unlisten(git_listen_id);
        });

        vacant.insert(SchedulerEntry { stop_tx });
    }

    /// Stop the per-workspace worker. Idempotent.
    pub fn stop(&self, workspace_id: &str) {
        // Removing drops `SchedulerEntry`, which sends the stop signal.
        self.entries.remove(workspace_id);
    }
}

fn worker_loop(
    workspace_id: &str,
    root_path: &str,
    base_branch: Option<String>,
    app: &AppHandle,
    trigger_rx: &Receiver<()>,
    stop_rx: &Receiver<()>,
) {
    let event_name = format!("git-state-{}", workspace_id);
    loop {
        crossbeam_channel::select! {
            recv(stop_rx) -> _ => break,
            recv(trigger_rx) -> _ => {
                // Drain any extra triggers that arrived between recv and now.
                // Combined with the capacity-1 channel, this gives the
                // single-flight + trailing semantics the plan calls for:
                // bursts of triggers collapse into one fetch.
                while trigger_rx.try_recv().is_ok() {}

                let payload = match compute_bundle(root_path, base_branch.clone()) {
                    Ok(bundle) => GitStateEvent::Bundle { bundle },
                    Err(err) => {
                        let not_git_repo = matches!(err, AbundioError::NotGitRepo(_));
                        GitStateEvent::Error {
                            message: format!("{}", err),
                            not_git_repo,
                        }
                    }
                };
                let _ = app.emit(&event_name, &payload);
            }
        }
    }
}

fn compute_bundle(
    root_path: &str,
    base_branch: Option<String>,
) -> Result<GitFetchBundle, AbundioError> {
    let (changed_res, branch_res, fp_res) = std::thread::scope(|s| {
        let h_changed =
            s.spawn(|| compute_changed_files_sync(root_path, base_branch.clone()));
        let h_branch = s.spawn(|| compute_branch_info_sync(root_path));
        let h_fp = s.spawn(|| compute_status_fingerprint_sync(root_path));
        (
            h_changed
                .join()
                .unwrap_or_else(|_| Err(AbundioError::Git("changed_files panic".into()))),
            h_branch
                .join()
                .unwrap_or_else(|_| Err(AbundioError::Git("branch_info panic".into()))),
            h_fp.join()
                .unwrap_or_else(|_| Err(AbundioError::Git("fingerprint panic".into()))),
        )
    });
    Ok(GitFetchBundle {
        changed_files: changed_res?,
        branch_info: branch_res?,
        status_fingerprint: fp_res?,
    })
}

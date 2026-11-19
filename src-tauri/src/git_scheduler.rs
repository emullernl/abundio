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

use crate::owner_map::OwnerMap;
use serde::Serialize;
use std::sync::Arc;

use crate::change_hub::ChangeHub;
use crate::event_sink::{Events, EventsExt};

use crate::error::AbundioError;
use crate::git_commands::{
    compute_branch_info_sync, compute_changed_files_sync, compute_status_fingerprint_sync,
    GitFetchBundle,
};

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
    /// The worker's base branch, so a `start` with a different one replaces it.
    base_branch: Option<String>,
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
    /// Window labels holding each worker, so a closed Window's workers stop.
    owners: OwnerMap,
    /// Where the file watcher announces changes.
    hub: Arc<ChangeHub>,
}

impl GitScheduler {
    pub fn new(hub: Arc<ChangeHub>) -> Self {
        Self {
            entries: DashMap::new(),
            owners: OwnerMap::new(),
            hub,
        }
    }

    /// Spawn a per-workspace worker on behalf of Window `owner`. Idempotent —
    /// calling `start` twice for the same `workspace_id` and `base_branch` is
    /// a no-op (matches `FileWatcher::start_watching`). A `start` with a
    /// different `base_branch` replaces the running worker, whoever else holds
    /// it: the frontend's stop-then-start would otherwise leave the old branch
    /// in place while another Window still held the workspace.
    pub fn start(
        &self,
        events: Events,
        owner: &str,
        workspace_id: String,
        root_path: String,
        base_branch: Option<String>,
    ) {
        use dashmap::mapref::entry::Entry;
        self.owners.claim(&workspace_id, owner);
        let entry = self.entries.entry(workspace_id.clone());
        if let Entry::Occupied(existing) = &entry {
            if existing.get().base_branch == base_branch {
                return;
            }
        }
        let entry_base_branch = base_branch.clone();

        // Capacity-1 channel = automatic coalescing. If the worker is busy
        // when many triggers arrive, only one is enqueued; the rest fall on
        // the floor via `try_send`. The worker drains any remaining one
        // after its compute finishes, so no real change is ever lost.
        let (trigger_tx, trigger_rx) = bounded::<()>(1);
        let (stop_tx, stop_rx) = bounded::<()>(1);

        // Subscribe to the file watcher's change notices for this root
        // (file and git changes alike). Loose coupling: `file_watcher.rs` does
        // not know the scheduler exists.
        let sub_id = self.hub.subscribe(&root_path, trigger_tx.clone());

        // Fire an initial trigger so the frontend has data immediately on
        // workspace open — no extra `invoke` from JS needed.
        let _ = trigger_tx.try_send(());

        // Worker thread. Owns its base_branch (immutable for its lifetime —
        // restarts on baseBranch change). On exit, unlistens both subscriptions.
        let hub = self.hub.clone();
        std::thread::spawn(move || {
            worker_loop(
                &workspace_id,
                &root_path,
                base_branch,
                &events,
                &trigger_rx,
                &stop_rx,
            );
            hub.unsubscribe(sub_id);
        });

        // Replacing an occupied entry drops the old one, which stops its worker.
        entry.insert(SchedulerEntry {
            stop_tx,
            base_branch: entry_base_branch,
        });
    }

    /// Drop Window `owner`'s hold on the worker, stopping it once no Window
    /// holds it. Idempotent.
    pub fn stop(&self, owner: &str, workspace_id: &str) {
        if self.owners.release(workspace_id, owner) {
            // Removing drops `SchedulerEntry`, which sends the stop signal.
            self.entries.remove(workspace_id);
        }
    }

    /// Stop every worker that only Window `owner` held. Called when the Window
    /// is destroyed, since its React cleanup never gets to call `stop`.
    pub fn release_window(&self, owner: &str) {
        for workspace_id in self.owners.release_owner(owner) {
            self.entries.remove(&workspace_id);
        }
    }
}

fn worker_loop(
    workspace_id: &str,
    root_path: &str,
    base_branch: Option<String>,
    events: &Events,
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
                events.broadcast(&event_name, &payload);
            }
        }
    }
}

fn compute_bundle(
    root_path: &str,
    base_branch: Option<String>,
) -> Result<GitFetchBundle, AbundioError> {
    let (changed_res, branch_res, fp_res, op_res, commits_res) = std::thread::scope(|s| {
        let h_changed =
            s.spawn(|| compute_changed_files_sync(root_path, base_branch.clone()));
        let h_commits = s.spawn(|| {
            crate::git_libgit2::compute_commit_history_sync(root_path, base_branch.clone())
        });
        let h_branch = s.spawn(|| compute_branch_info_sync(root_path));
        let h_fp = s.spawn(|| compute_status_fingerprint_sync(root_path));
        let h_op = s.spawn(|| {
            crate::git_libgit2::compute_operation_in_progress_sync(root_path)
        });
        (
            h_changed
                .join()
                .unwrap_or_else(|_| Err(AbundioError::Git("changed_files panic".into()))),
            h_branch
                .join()
                .unwrap_or_else(|_| Err(AbundioError::Git("branch_info panic".into()))),
            h_fp.join()
                .unwrap_or_else(|_| Err(AbundioError::Git("fingerprint panic".into()))),
            h_op.join()
                .unwrap_or_else(|_| Err(AbundioError::Git("operation state panic".into()))),
            h_commits
                .join()
                .unwrap_or_else(|_| Err(AbundioError::Git("branch commits panic".into()))),
        )
    });
    Ok(GitFetchBundle {
        changed_files: changed_res?,
        branch_info: branch_res?,
        status_fingerprint: fp_res?,
        operation_in_progress: op_res.unwrap_or(None),
        commit_history: commits_res.ok(),
    })
}

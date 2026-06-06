//! Live-sync watcher for git worktrees. Watches each distinct repository's
//! common git dir for `git worktree add/remove` activity (which lands under
//! `.git/worktrees/`) and emits a debounced `worktrees-changed` event so the
//! frontend can reconcile its Workspace list against disk. One watcher per
//! repo; the watched set is the union of every Window's active-Profile repos.
//! See ADR-0017.

use std::collections::HashSet;
use std::path::{Component, Path};
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use dashmap::DashMap;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;

const DEBOUNCE_MS: u64 = 400;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreesChanged {
    common_dir: String,
}

struct WatchEntry {
    _watcher: RecommendedWatcher,
    stop_tx: Sender<()>,
}

impl Drop for WatchEntry {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

pub struct WorktreeWatcher {
    /// common git dir → live watcher (the union across Windows).
    watchers: DashMap<String, WatchEntry>,
    /// window label → that Window's desired set of common git dirs.
    per_window: DashMap<String, HashSet<String>>,
}

impl WorktreeWatcher {
    pub fn new() -> Self {
        Self {
            watchers: DashMap::new(),
            per_window: DashMap::new(),
        }
    }

    /// Record this Window's desired watch set and reconcile the live watchers
    /// to the union across all Windows.
    pub fn set_watched(&self, app: &AppHandle, window_label: &str, common_dirs: Vec<String>) {
        self.per_window
            .insert(window_label.to_string(), common_dirs.into_iter().collect());
        self.reconcile(app);
    }

    /// Drop a closed Window's contribution and reconcile.
    pub fn forget_window(&self, app: &AppHandle, window_label: &str) {
        if self.per_window.remove(window_label).is_some() {
            self.reconcile(app);
        }
    }

    fn reconcile(&self, app: &AppHandle) {
        let union: HashSet<String> = self
            .per_window
            .iter()
            .flat_map(|e| e.value().iter().cloned().collect::<Vec<_>>())
            .collect();

        // Drop watchers no longer desired by any Window.
        let existing: Vec<String> = self.watchers.iter().map(|e| e.key().clone()).collect();
        for key in existing {
            if !union.contains(&key) {
                self.watchers.remove(&key);
            }
        }
        // Start watchers for newly desired repos.
        for dir in union {
            if self.watchers.contains_key(&dir) {
                continue;
            }
            if let Err(e) = self.start_one(app.clone(), &dir) {
                eprintln!("[abundio] worktree watch failed for {dir}: {e}");
            }
        }
    }

    fn start_one(&self, app: AppHandle, common_dir: &str) -> Result<(), AbundioError> {
        let path = Path::new(common_dir);
        if !path.exists() {
            return Ok(());
        }
        let (event_tx, event_rx) = unbounded::<Event>();
        let (stop_tx, stop_rx) = bounded::<()>(1);

        let mut watcher =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = event_tx.send(event);
                }
            })
            .map_err(|e| AbundioError::Watcher(e.to_string()))?;

        // Recursive watch on the common git dir. `.git` churns on every git
        // op, but the debounce loop only emits when an event touches a
        // `worktrees` path, so add/remove are the only triggers in practice.
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| AbundioError::Watcher(e.to_string()))?;

        let common = common_dir.to_string();
        std::thread::spawn(move || {
            debounce_loop(&common, &app, &event_rx, &stop_rx);
        });

        self.watchers.insert(
            common_dir.to_string(),
            WatchEntry {
                _watcher: watcher,
                stop_tx,
            },
        );
        Ok(())
    }
}

impl Default for WorktreeWatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// True if any path in the event references a `worktrees` directory component —
/// i.e. a worktree was added or removed (admin entries live in
/// `<common>/worktrees/<name>`).
fn is_worktree_admin_event(event: &Event) -> bool {
    event.paths.iter().any(|p| {
        p.components()
            .any(|c| matches!(c, Component::Normal(s) if s == "worktrees"))
    })
}

fn debounce_loop(
    common_dir: &str,
    app: &AppHandle,
    event_rx: &Receiver<Event>,
    stop_rx: &Receiver<()>,
) {
    let timeout = Duration::from_millis(DEBOUNCE_MS);
    loop {
        let mut relevant;
        crossbeam_channel::select! {
            recv(stop_rx) -> _ => break,
            recv(event_rx) -> msg => {
                relevant = matches!(msg, Ok(ref ev) if is_worktree_admin_event(ev));
            }
        }

        // Coalesce a burst within the debounce window.
        loop {
            crossbeam_channel::select! {
                recv(stop_rx) -> _ => return,
                recv(event_rx) -> msg => {
                    if let Ok(ev) = msg {
                        relevant |= is_worktree_admin_event(&ev);
                    }
                }
                default(timeout) => break,
            }
        }

        if relevant {
            let _ = app.emit(
                "worktrees-changed",
                WorktreesChanged {
                    common_dir: common_dir.to_string(),
                },
            );
        }
    }
}

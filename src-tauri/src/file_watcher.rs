use std::collections::HashSet;
use std::path::{Component, Path};
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Sender};
use dashmap::DashMap;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;
use crate::events::FsChange;

const DEBOUNCE_MS: u64 = 200;

/// Directories whose changes we never forward to the frontend.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(
            c,
            Component::Normal(s)
                if matches!(s.to_str(), Some(".git" | "node_modules" | ".DS_Store" | "target"))
        )
    })
}

struct WatcherEntry {
    _watcher: RecommendedWatcher,
    stop_tx: Sender<()>,
}

impl Drop for WatcherEntry {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

pub struct FileWatcher {
    watchers: DashMap<String, WatcherEntry>,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            watchers: DashMap::new(),
        }
    }

    pub fn start_watching(&self, app: AppHandle, root_path: &str) -> Result<(), AbundioError> {
        // Atomic check-and-insert to avoid TOCTOU race condition
        use dashmap::mapref::entry::Entry;
        let entry = self.watchers.entry(root_path.to_string());
        if matches!(entry, Entry::Occupied(_)) {
            return Ok(());
        }
        let vacant = match entry {
            Entry::Vacant(v) => v,
            Entry::Occupied(_) => return Ok(()),
        };

        let (event_tx, event_rx) = unbounded::<Event>();
        let (stop_tx, stop_rx) = bounded::<()>(1);

        // Build the watcher, forwarding raw notify events into the channel
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        })
        .map_err(|e| AbundioError::Watcher(e.to_string()))?;

        watcher
            .watch(Path::new(root_path), RecursiveMode::Recursive)
            .map_err(|e| AbundioError::Watcher(e.to_string()))?;

        // Spawn debounce thread
        let root = root_path.to_string();
        let app_handle = app.clone();
        std::thread::spawn(move || {
            debounce_loop(&root, &app_handle, &event_rx, &stop_rx);
        });

        vacant.insert(WatcherEntry {
            _watcher: watcher,
            stop_tx,
        });

        Ok(())
    }

    pub fn stop_watching(&self, root_path: &str) {
        // Removing drops the WatcherEntry, which sends the stop signal and drops the watcher
        self.watchers.remove(root_path);
    }
}

fn debounce_loop(
    root_path: &str,
    app: &AppHandle,
    event_rx: &crossbeam_channel::Receiver<Event>,
    stop_rx: &crossbeam_channel::Receiver<()>,
) {
    let mut pending: HashSet<String> = HashSet::new();
    let timeout = Duration::from_millis(DEBOUNCE_MS);

    loop {
        // Wait for an event or stop signal
        crossbeam_channel::select! {
            recv(stop_rx) -> _ => break,
            recv(event_rx) -> msg => {
                if let Ok(event) = msg {
                    collect_parents(&event, &mut pending);
                }
            }
        }

        // Drain any additional events within the debounce window
        loop {
            crossbeam_channel::select! {
                recv(stop_rx) -> _ => return,
                recv(event_rx) -> msg => {
                    if let Ok(event) = msg {
                        collect_parents(&event, &mut pending);
                    }
                }
                default(timeout) => break,
            }
        }

        // Emit batched event with root in payload (avoids invalid chars in event name)
        if !pending.is_empty() {
            let paths: Vec<String> = pending.drain().collect();
            let _ = app.emit(
                "fs-change",
                FsChange {
                    root: root_path.to_string(),
                    paths,
                },
            );
        }
    }
}

fn collect_parents(event: &Event, pending: &mut HashSet<String>) {
    for path in &event.paths {
        if is_ignored(path) {
            continue;
        }
        // Add the parent directory (the directory whose listing changed)
        if let Some(parent) = path.parent() {
            pending.insert(parent.to_string_lossy().to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::EventKind;
    use std::path::PathBuf;

    #[test]
    fn is_ignored_git_directory() {
        assert!(is_ignored(Path::new("/projects/myapp/.git/HEAD")));
        assert!(is_ignored(Path::new("/projects/myapp/.git/refs/heads/main")));
    }

    #[test]
    fn is_ignored_node_modules() {
        assert!(is_ignored(Path::new("/projects/myapp/node_modules/lodash/index.js")));
    }

    #[test]
    fn is_ignored_target_directory() {
        assert!(is_ignored(Path::new("/projects/myapp/target/debug/build")));
    }

    #[test]
    fn is_ignored_ds_store() {
        assert!(is_ignored(Path::new("/projects/myapp/.DS_Store")));
    }

    #[test]
    fn is_ignored_normal_paths() {
        assert!(!is_ignored(Path::new("/projects/myapp/src/main.rs")));
        assert!(!is_ignored(Path::new("/projects/myapp/package.json")));
        assert!(!is_ignored(Path::new("/projects/myapp/src/components/App.tsx")));
    }

    #[test]
    fn collect_parents_adds_parent_dirs() {
        let mut pending = HashSet::new();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/projects/myapp/src/main.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending);
        assert!(pending.contains("/projects/myapp/src"));
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn collect_parents_deduplicates() {
        let mut pending = HashSet::new();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![
                PathBuf::from("/projects/myapp/src/a.rs"),
                PathBuf::from("/projects/myapp/src/b.rs"),
            ],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending);
        assert_eq!(pending.len(), 1);
        assert!(pending.contains("/projects/myapp/src"));
    }

    #[test]
    fn collect_parents_skips_ignored() {
        let mut pending = HashSet::new();
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![
                PathBuf::from("/projects/myapp/.git/HEAD"),
                PathBuf::from("/projects/myapp/src/main.rs"),
            ],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending);
        assert_eq!(pending.len(), 1);
        assert!(pending.contains("/projects/myapp/src"));
    }

    #[test]
    fn collect_parents_handles_root_path() {
        let mut pending = HashSet::new();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/file.txt")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending);
        assert!(pending.contains("/"));
    }
}

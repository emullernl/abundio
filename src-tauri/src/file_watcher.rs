use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Sender};
use dashmap::DashMap;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;
use crate::events::FsChange;

const DEBOUNCE_MS: u64 = 200;

/// Directories whose changes we never forward to the frontend.
fn is_ignored(path: &str) -> bool {
    let components: Vec<&str> = path.split('/').collect();
    components
        .iter()
        .any(|c| *c == ".git" || *c == "node_modules" || *c == ".DS_Store" || *c == "target")
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
        // Idempotent — if already watching, do nothing
        if self.watchers.contains_key(root_path) {
            return Ok(());
        }

        let (event_tx, event_rx) = unbounded::<Event>();
        let (stop_tx, stop_rx) = bounded::<()>(1);

        // Build the watcher, forwarding raw notify events into the channel
        let tx = event_tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
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

        self.watchers.insert(
            root_path.to_string(),
            WatcherEntry {
                _watcher: watcher,
                stop_tx,
            },
        );

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

        // Emit batched event
        if !pending.is_empty() {
            let paths: Vec<String> = pending.drain().collect();
            let event_name = format!("fs-change-{}", root_path);
            let _ = app.emit(&event_name, FsChange { paths });
        }
    }
}

fn collect_parents(event: &Event, pending: &mut HashSet<String>) {
    for path in &event.paths {
        let path_str = path.to_string_lossy().to_string();
        if is_ignored(&path_str) {
            continue;
        }
        // Add the parent directory (the directory whose listing changed)
        if let Some(parent) = path.parent() {
            pending.insert(parent.to_string_lossy().to_string());
        }
    }
}

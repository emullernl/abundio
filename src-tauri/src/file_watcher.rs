use std::collections::HashSet;
use std::path::{Component, Path};
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Sender};
use dashmap::DashMap;
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::AbundioError;
use crate::events::{FsChange, GitChange};

const DEBOUNCE_MS: u64 = 200;

/// Directories whose changes we never forward to the frontend.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(
            c,
            Component::Normal(s)
                if matches!(s.to_str(), Some("node_modules" | ".DS_Store" | "target"))
        )
    })
}

/// Whether the path is inside the `.git` directory.
fn is_git_internal(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(c, Component::Normal(s) if s == ".git")
    })
}

/// Whether the path is the `.git` directory itself (its final component is
/// `.git`), as opposed to something nested inside it. The creation of this
/// directory is the non-git → git transition (`git init` / a fresh clone).
fn is_dot_git_dir(path: &Path) -> bool {
    matches!(path.file_name().and_then(|s| s.to_str()), Some(".git"))
}

/// Whether a `.git` path represents a meaningful ref change (branch switch,
/// commit, merge, rebase) rather than an index/lock refresh. Read-only git
/// commands with `--no-optional-locks` still touch the index occasionally;
/// we don't want those to trigger full git-change events.
fn is_meaningful_git_change(path: &Path) -> bool {
    // Match on path *components*, never on a substring of the rendered path.
    // Two reasons: in a linked worktree these files live under
    // `.git/worktrees/<name>/`, so a `.git/`-prefixed substring never appears;
    // and a forward-slash substring never matches on Windows at all, so a plain
    // branch-ref update would go unnoticed there.
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if matches!(
        name,
        "HEAD" | "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "COMMIT_EDITMSG"
            | "packed-refs"
    ) {
        return true;
    }
    // Anything under a `refs` directory: heads, remotes, tags.
    path.components()
        .any(|c| matches!(c, Component::Normal(s) if s == "refs"))
}

/// The repository's gitdir when it lies *outside* `root_path` — i.e. this
/// workspace is a linked worktree. `None` for a main worktree (whose gitdir is
/// the `.git` directory already covered by the recursive watch) or a non-repo.
/// Resolved once, when the watch is established. Converting a workspace into a
/// worktree (or `git worktree add`-ing it) afterwards is not picked up until the
/// watcher is recreated — acceptable because workspaces are watched on open.
fn external_gitdir(root_path: &str) -> Option<std::path::PathBuf> {
    let repo = git2::Repository::discover(root_path).ok()?;
    let gitdir = repo.path().to_path_buf();
    let root = std::fs::canonicalize(root_path).ok()?;
    let canonical = std::fs::canonicalize(&gitdir).unwrap_or(gitdir);
    if canonical.starts_with(&root) {
        None
    } else {
        Some(canonical)
    }
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

        // A *linked* worktree's gitdir lives at `<repo>/.git/worktrees/<name>/`,
        // outside this workspace folder — so MERGE_HEAD/REBASE_HEAD changes there
        // would never reach the recursive watch above. Without this, finishing a
        // merge with `git merge --continue` (which touches no file in the
        // worktree) leaves the UI believing the merge is still running.
        if let Some(gitdir) = external_gitdir(root_path) {
            // Best-effort: a missing or unreadable gitdir just means no second
            // watch, which is the pre-existing behaviour.
            let _ = watcher.watch(&gitdir, RecursiveMode::Recursive);
        }

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
    let mut changed_files: HashSet<String> = HashSet::new();
    let mut removed_files: HashSet<String> = HashSet::new();
    let mut git_changed = false;
    let timeout = Duration::from_millis(DEBOUNCE_MS);

    loop {
        // Wait for an event or stop signal
        crossbeam_channel::select! {
            recv(stop_rx) -> _ => break,
            recv(event_rx) -> msg => {
                if let Ok(event) = msg {
                    collect_parents(
                        &event,
                        &mut pending,
                        &mut changed_files,
                        &mut removed_files,
                        &mut git_changed,
                    );
                }
            }
        }

        // Drain any additional events within the debounce window
        loop {
            crossbeam_channel::select! {
                recv(stop_rx) -> _ => return,
                recv(event_rx) -> msg => {
                    if let Ok(event) = msg {
                        collect_parents(
                            &event,
                            &mut pending,
                            &mut changed_files,
                            &mut removed_files,
                            &mut git_changed,
                        );
                    }
                }
                default(timeout) => break,
            }
        }

        // Emit batched event with root in payload (avoids invalid chars in event name)
        if !pending.is_empty() || !changed_files.is_empty() || !removed_files.is_empty() {
            let paths: Vec<String> = pending.drain().collect();
            // A path removed in this window can also appear in changed (e.g. create+delete).
            // Prefer "removed" semantics: strip any removed path from the changed set.
            for p in &removed_files {
                changed_files.remove(p);
            }
            let changed: Vec<String> = changed_files.drain().collect();
            let removed: Vec<String> = removed_files.drain().collect();
            let _ = app.emit(
                "fs-change",
                FsChange {
                    root: root_path.to_string(),
                    paths,
                    changed_files: changed,
                    removed_files: removed,
                },
            );
        }

        // Both events may fire in the same cycle (e.g. on git commit).
        // The frontend debounce coalesces them, so no double-fetch occurs.
        if git_changed {
            git_changed = false;
            let _ = app.emit(
                "git-change",
                GitChange {
                    root: root_path.to_string(),
                },
            );
        }
    }
}

/// Classifies an `EventKind` into how it should affect the changed/removed
/// file sets. `None` means the event should not touch either set (e.g. a
/// metadata-only touch we don't want to treat as a content change).
fn classify_kind(kind: &EventKind) -> Option<FileChangeClass> {
    match kind {
        EventKind::Create(_) => Some(FileChangeClass::Changed),
        EventKind::Remove(_) => Some(FileChangeClass::Removed),
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::From => Some(FileChangeClass::Removed),
            RenameMode::To => Some(FileChangeClass::Changed),
            // `Both` and `Any` carry both source and dest in event.paths;
            // treat as changed and let the consumer handle the pair.
            _ => Some(FileChangeClass::Changed),
        },
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => {
            Some(FileChangeClass::Changed)
        }
        // Metadata-only or other noisy kinds: only dir-listing refresh.
        _ => None,
    }
}

#[derive(Copy, Clone)]
enum FileChangeClass {
    Changed,
    Removed,
}

fn collect_parents(
    event: &Event,
    pending: &mut HashSet<String>,
    changed_files: &mut HashSet<String>,
    removed_files: &mut HashSet<String>,
    git_changed: &mut bool,
) {
    let class = classify_kind(&event.kind);
    let is_create = matches!(event.kind, EventKind::Create(_));
    for path in &event.paths {
        if is_ignored(path) {
            continue;
        }
        if is_git_internal(path) {
            if is_meaningful_git_change(path) {
                *git_changed = true;
            } else if is_create && is_dot_git_dir(path) {
                // `git init` (or a fresh clone) just created the repo's `.git`
                // dir — the non-git → git transition. FSEvents may coalesce the
                // burst of inner-file creates into a single event on the dir
                // itself, which wouldn't match `is_meaningful_git_change`, so
                // recognize it here to trigger a git refresh.
                *git_changed = true;
            }
            continue;
        }
        // Add the parent directory (the directory whose listing changed)
        if let Some(parent) = path.parent() {
            pending.insert(parent.to_string_lossy().to_string());
        }
        // Route the file path itself
        if let Some(class) = class {
            let s = path.to_string_lossy().to_string();
            match class {
                FileChangeClass::Changed => {
                    changed_files.insert(s);
                }
                FileChangeClass::Removed => {
                    removed_files.insert(s);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::EventKind;
    use std::path::PathBuf;

    #[test]
    fn git_internal_detected() {
        assert!(is_git_internal(Path::new("/projects/myapp/.git/HEAD")));
        assert!(is_git_internal(Path::new("/projects/myapp/.git/refs/heads/main")));
        assert!(!is_git_internal(Path::new("/projects/myapp/src/main.rs")));
    }

    #[test]
    fn dot_git_dir_detected() {
        assert!(is_dot_git_dir(Path::new("/projects/myapp/.git")));
        // Children of `.git` are not the dir itself.
        assert!(!is_dot_git_dir(Path::new("/projects/myapp/.git/HEAD")));
        assert!(!is_dot_git_dir(Path::new("/projects/myapp/src/main.rs")));
    }

    #[test]
    fn meaningful_git_change_matches_main_worktree_paths() {
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/HEAD")));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/MERGE_HEAD")));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/REBASE_HEAD")));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/CHERRY_PICK_HEAD")));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/packed-refs")));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/refs/heads/main")));
        assert!(is_meaningful_git_change(Path::new(
            "/p/app/.git/refs/remotes/origin/main"
        )));
        assert!(is_meaningful_git_change(Path::new("/p/app/.git/refs/tags/v1")));
    }

    #[test]
    fn meaningful_git_change_matches_refs_by_component_not_substring() {
        // Built up componentwise so the assertion holds on Windows too, where a
        // rendered path uses backslashes and a "/refs/" substring never matches.
        let mut p = std::path::PathBuf::from("C:");
        for part in ["repo", ".git", "refs", "heads", "feature"] {
            p.push(part);
        }
        assert!(is_meaningful_git_change(&p));

        // A file merely *named* refs is not a ref directory.
        let mut not_refs = std::path::PathBuf::from("/p/app/.git");
        not_refs.push("refs.lock");
        assert!(!is_meaningful_git_change(&not_refs));
    }

    #[test]
    fn meaningful_git_change_matches_linked_worktree_paths() {
        // A linked worktree's gitdir is `<repo>/.git/worktrees/<name>/`, so the
        // old `.git/MERGE_HEAD` substring never matched and finishing a merge
        // there left the UI stale.
        assert!(is_meaningful_git_change(Path::new(
            "/p/app/.git/worktrees/feat-x/MERGE_HEAD"
        )));
        assert!(is_meaningful_git_change(Path::new(
            "/p/app/.git/worktrees/feat-x/REBASE_HEAD"
        )));
        assert!(is_meaningful_git_change(Path::new(
            "/p/app/.git/worktrees/feat-x/HEAD"
        )));
    }

    #[test]
    fn meaningful_git_change_still_ignores_the_index() {
        // Read-only git commands touch the index constantly; forwarding those
        // would reintroduce the churn the filter exists to suppress.
        assert!(!is_meaningful_git_change(Path::new("/p/app/.git/index")));
        assert!(!is_meaningful_git_change(Path::new("/p/app/.git/index.lock")));
        assert!(!is_meaningful_git_change(Path::new(
            "/p/app/.git/worktrees/feat-x/index"
        )));
        assert!(!is_meaningful_git_change(Path::new("/p/app/.git/config")));
    }

    #[test]
    fn external_gitdir_is_none_for_a_main_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        // The gitdir is `<root>/.git`, already covered by the recursive watch.
        assert!(external_gitdir(root).is_none());
    }

    #[test]
    fn external_gitdir_is_some_for_a_linked_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let git = |args: &[&str], cwd: &str| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
        };
        git(&["init"], root);
        git(&["config", "user.email", "t@example.com"], root);
        git(&["config", "user.name", "T"], root);
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        git(&["add", "."], root);
        git(&["commit", "-m", "init"], root);

        let linked = dir.path().join("wt");
        git(
            &["worktree", "add", linked.to_str().unwrap(), "-b", "feat"],
            root,
        );

        let found = external_gitdir(linked.to_str().unwrap());
        assert!(found.is_some(), "linked worktree gitdir should be external");
        let found = found.unwrap();
        assert!(
            found.to_string_lossy().contains("worktrees"),
            "expected a worktrees gitdir, got {found:?}"
        );
    }

    #[test]
    fn collect_parents_git_init_triggers_git_change() {
        // `git init` surfaced as the creation of the `.git` directory itself
        // (FSEvents coalescing the inner-file burst). This is the non-git → git
        // transition and must trigger a git refresh.
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::Folder),
            paths: vec![PathBuf::from("/projects/myapp/.git")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(git_changed);
        // The `.git` dir itself is not surfaced as a normal file/dir change.
        assert!(pending.is_empty());
        assert!(changed.is_empty());
    }

    #[test]
    fn collect_parents_git_dir_removal_does_not_trigger_git_change() {
        // Only *creation* of `.git` is the init signal; a removal (or any other
        // event) on the dir must not be mistaken for it here.
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::Folder),
            paths: vec![PathBuf::from("/projects/myapp/.git")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(!git_changed);
    }

    #[test]
    fn is_ignored_does_not_include_git() {
        // .git paths are handled separately via is_git_internal, not ignored
        assert!(!is_ignored(Path::new("/projects/myapp/.git/HEAD")));
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

    fn empty_sets() -> (HashSet<String>, HashSet<String>, HashSet<String>, bool) {
        (HashSet::new(), HashSet::new(), HashSet::new(), false)
    }

    #[test]
    fn collect_parents_adds_parent_dirs() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/projects/myapp/src/main.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(pending.contains("/projects/myapp/src"));
        assert_eq!(pending.len(), 1);
        assert!(changed.contains("/projects/myapp/src/main.rs"));
        assert!(removed.is_empty());
        assert!(!git_changed);
    }

    #[test]
    fn collect_parents_deduplicates() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![
                PathBuf::from("/projects/myapp/src/a.rs"),
                PathBuf::from("/projects/myapp/src/b.rs"),
            ],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert_eq!(pending.len(), 1);
        assert!(pending.contains("/projects/myapp/src"));
        assert_eq!(changed.len(), 2);
    }

    #[test]
    fn collect_parents_routes_git_changes() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
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
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert_eq!(pending.len(), 1);
        assert!(pending.contains("/projects/myapp/src"));
        assert!(changed.contains("/projects/myapp/src/main.rs"));
        assert!(!changed.iter().any(|p| p.contains(".git")));
        assert!(git_changed);
    }

    #[test]
    fn collect_parents_handles_root_path() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/file.txt")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(pending.contains("/"));
        assert!(changed.contains("/file.txt"));
        assert!(!git_changed);
    }

    #[test]
    fn collect_parents_modify_data_is_changed() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from("/projects/myapp/src/main.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(changed.contains("/projects/myapp/src/main.rs"));
        assert!(removed.is_empty());
    }

    #[test]
    fn collect_parents_remove_is_removed() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![PathBuf::from("/projects/myapp/src/main.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(removed.contains("/projects/myapp/src/main.rs"));
        assert!(changed.is_empty());
        // Parent dir refresh still happens.
        assert!(pending.contains("/projects/myapp/src"));
    }

    #[test]
    fn collect_parents_rename_from_is_removed() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            paths: vec![PathBuf::from("/projects/myapp/src/old.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(removed.contains("/projects/myapp/src/old.rs"));
        assert!(changed.is_empty());
    }

    #[test]
    fn collect_parents_rename_to_is_changed() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            paths: vec![PathBuf::from("/projects/myapp/src/new.rs")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(changed.contains("/projects/myapp/src/new.rs"));
        assert!(removed.is_empty());
    }

    #[test]
    fn collect_parents_ignored_paths_skipped() {
        let (mut pending, mut changed, mut removed, mut git_changed) = empty_sets();
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/projects/myapp/node_modules/lodash/index.js")],
            attrs: Default::default(),
        };
        collect_parents(&event, &mut pending, &mut changed, &mut removed, &mut git_changed);
        assert!(pending.is_empty());
        assert!(changed.is_empty());
        assert!(removed.is_empty());
    }

    #[test]
    fn git_internal_matches_git_dir_itself() {
        // is_git_internal matches the `.git` directory itself, not just its children.
        // This is intentional — changes to `.git` are a valid git-change signal.
        assert!(is_git_internal(Path::new("/projects/myapp/.git")));
    }
}

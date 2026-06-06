//! Tauri command layer for git worktrees. All git work delegates to
//! `git_libgit2`; these wrappers run it on `spawn_blocking` so the tokio
//! runtime is never blocked, mirroring `git_commands.rs`. See ADR-0017.

use serde::Serialize;

use crate::error::AbundioError;
use crate::git_libgit2;

/// One worktree of a repository, as surfaced to the frontend for grouping,
/// expansion-on-create, and the Add/Remove flows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    /// Canonicalized worktree root folder.
    pub path: String,
    /// Checked-out branch shorthand, or None if detached/unborn/missing.
    pub branch: Option<String>,
    /// True for the repository's main worktree (the Primary worktree).
    pub is_primary: bool,
    /// Whether the worktree's folder still exists on disk. A git-tracked
    /// worktree whose folder is gone (`exists: false`) is "prunable" — present
    /// here so the frontend can distinguish a stale folder (keep, render stale)
    /// from a git-confirmed removal (entry absent entirely → safe to delete).
    pub exists: bool,
}

/// List every worktree of the repository that `cwd` belongs to (primary first).
#[tauri::command]
pub async fn list_repo_worktrees(cwd: String) -> Result<Vec<WorktreeEntry>, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::list_repo_worktrees(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("worktree task failed: {e}")))?
}

/// Create a new worktree of the primary's repository, checking out `branch`
/// (created from the primary's HEAD if it doesn't exist) at the absolute `path`.
#[tauri::command]
pub async fn worktree_add(
    primary_cwd: String,
    branch: String,
    path: String,
) -> Result<WorktreeEntry, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::add_worktree(&primary_cwd, &branch, &path))
        .await
        .map_err(|e| AbundioError::Git(format!("worktree task failed: {e}")))?
}

/// Remove the worktree whose folder is `worktree_path` (deletes the folder,
/// prunes git's admin link, keeps the branch).
#[tauri::command]
pub async fn worktree_remove(
    primary_cwd: String,
    worktree_path: String,
) -> Result<(), AbundioError> {
    tokio::task::spawn_blocking(move || {
        git_libgit2::remove_worktree(&primary_cwd, &worktree_path)
    })
    .await
    .map_err(|e| AbundioError::Git(format!("worktree task failed: {e}")))?
}

/// True if the worktree at `cwd` has uncommitted or untracked changes — drives
/// the dirty-aware Remove confirmation.
#[tauri::command]
pub async fn worktree_dirty(cwd: String) -> Result<bool, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::worktree_is_dirty(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("worktree task failed: {e}")))
}

#[cfg(test)]
mod tests {
    use crate::git_libgit2;
    use std::process::Command;

    fn run_git(cwd: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn setup_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run_git(p, &["init", "-b", "main"]);
        run_git(p, &["config", "user.email", "t@t.com"]);
        run_git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        run_git(p, &["add", "."]);
        run_git(p, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn main_worktree_is_primary_and_grouped() {
        let dir = setup_repo();
        let cwd = dir.path().to_str().unwrap();
        let bits = git_libgit2::worktree_summary_bits(cwd);
        assert!(bits.is_main_worktree);
        assert!(bits.group_key.is_some());
    }

    #[test]
    fn add_then_list_then_remove_worktree() {
        let dir = setup_repo();
        let primary = dir.path().to_str().unwrap().to_string();
        let wt_path = dir.path().parent().unwrap().join("wt-feature");
        let wt_path_str = wt_path.to_str().unwrap().to_string();

        // New branch + worktree.
        let entry =
            git_libgit2::add_worktree(&primary, "feature", &wt_path_str).expect("add worktree");
        assert!(!entry.is_primary);
        assert_eq!(entry.branch.as_deref(), Some("feature"));
        assert!(wt_path.exists());

        // Both worktrees share a group key; primary detected.
        let list = git_libgit2::list_repo_worktrees(&primary).expect("list");
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|e| e.is_primary));
        assert!(list.iter().any(|e| !e.is_primary && e.branch.as_deref() == Some("feature")));

        let primary_key = git_libgit2::worktree_summary_bits(&primary).group_key;
        let linked_key = git_libgit2::worktree_summary_bits(&wt_path_str).group_key;
        assert_eq!(primary_key, linked_key);
        assert!(!git_libgit2::worktree_summary_bits(&wt_path_str).is_main_worktree);

        // Remove deletes the folder but keeps the branch.
        git_libgit2::remove_worktree(&primary, &wt_path_str).expect("remove");
        assert!(!wt_path.exists());
        let after = git_libgit2::list_repo_worktrees(&primary).expect("list after");
        assert_eq!(after.len(), 1);

        // Branch survives removal.
        let out = Command::new("git")
            .args(["branch", "--list", "feature"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("feature"));
    }

    #[test]
    fn add_worktree_rejects_existing_folder() {
        let dir = setup_repo();
        let primary = dir.path().to_str().unwrap().to_string();
        let existing = dir.path().parent().unwrap().join("already-here");
        std::fs::create_dir_all(&existing).unwrap();
        let res = git_libgit2::add_worktree(&primary, "x", existing.to_str().unwrap());
        assert!(res.is_err());
    }

    #[test]
    fn group_key_matches_for_separate_gitdir_worktree() {
        // A repo created with --separate-git-dir has `<work>/.git` as a *file*
        // pointing at the real gitdir. Exercises the `commondir`-file path in
        // common_git_dir (is_worktree branch) for the linked worktree.
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        let gitdir = dir.path().join("gd");
        std::fs::create_dir_all(&work).unwrap();
        run_git(
            &work,
            &["init", "--separate-git-dir", gitdir.to_str().unwrap(), "-b", "main"],
        );
        run_git(&work, &["config", "user.email", "t@t.com"]);
        run_git(&work, &["config", "user.name", "T"]);
        std::fs::write(work.join("a.txt"), "x\n").unwrap();
        run_git(&work, &["add", "."]);
        run_git(&work, &["commit", "-m", "init"]);
        let wt = dir.path().join("wt");
        run_git(
            &work,
            &["worktree", "add", "-b", "feature", wt.to_str().unwrap()],
        );

        let main_key =
            git_libgit2::worktree_summary_bits(work.to_str().unwrap()).group_key;
        let linked_key =
            git_libgit2::worktree_summary_bits(wt.to_str().unwrap()).group_key;
        assert!(main_key.is_some());
        assert_eq!(
            main_key, linked_key,
            "separate-git-dir worktrees must share a group key"
        );
    }

    #[test]
    fn worktree_dirty_detects_untracked() {
        let dir = setup_repo();
        let cwd = dir.path().to_str().unwrap();
        assert!(!git_libgit2::worktree_is_dirty(cwd));
        std::fs::write(dir.path().join("new.txt"), "x\n").unwrap();
        assert!(git_libgit2::worktree_is_dirty(cwd));
    }
}

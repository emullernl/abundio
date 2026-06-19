use crate::error::AbundioError;
use crate::git_libgit2;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

/// Per-repo cache of the detected default branch name.
/// Keyed by the canonicalized repo working directory path.
/// Note: this cache lives for the process lifetime. If the remote default
/// branch is renamed, the app must be restarted to pick up the change.
fn default_branch_cache() -> &'static DashMap<String, String> {
    static CACHE: OnceLock<DashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub additions: i32,
    pub deletions: i32,
    pub section: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub original: String,
    pub modified: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub default_branch: String,
    pub current_branch: String,
}

fn cache_key_for(cwd: &str) -> String {
    std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string())
}

fn detect_default_branch(cwd: &str) -> Result<String, AbundioError> {
    let key = cache_key_for(cwd);
    if let Some(cached) = default_branch_cache().get(&key) {
        return Ok(cached.clone());
    }
    let detected = git_libgit2::detect_default_branch_uncached(cwd)?;
    default_branch_cache().insert(key, detected.clone());
    Ok(detected)
}

fn resolve_base_branch(cwd: &str, base_branch: Option<String>) -> Result<String, AbundioError> {
    match base_branch {
        Some(b) if !b.is_empty() => Ok(b),
        _ => detect_default_branch(cwd),
    }
}

// All git operations in this module now delegate to libgit2 (`git_libgit2`).
// The hot path — the three sync helpers the `GitScheduler` runs on every
// fs/git event — was the original motivation for the swap: each subprocess
// `git` call cost ~50-300 ms on macOS, and the scheduler issued 5+ of them
// per refresh, which stalled the WKWebView's main thread long enough to
// freeze terminal typing during a `git stash`. The remaining commands
// (`git_file_diff`, `git_list_branches`, `git_workspaces_summary`) are
// user-action one-shots, but they now also use libgit2 for consistency and
// to keep the entire production binary subprocess-free for git.

pub(crate) fn compute_changed_files_sync(
    cwd: &str,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    crate::git_libgit2::compute_changed_files_sync(cwd, base_branch)
}

pub(crate) fn compute_branch_info_sync(cwd: &str) -> Result<BranchInfo, AbundioError> {
    crate::git_libgit2::compute_branch_info_sync(cwd)
}

pub(crate) fn compute_status_fingerprint_sync(cwd: &str) -> Result<String, AbundioError> {
    crate::git_libgit2::compute_status_fingerprint_sync(cwd)
}

#[tauri::command]
pub async fn git_changed_files(
    cwd: String,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    tokio::task::spawn_blocking(move || compute_changed_files_sync(&cwd, base_branch))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

/// The GitHub `owner/repo` for a workspace folder, or None if it has no github
/// remote. Drives the client-side All-vs-Repo PR filter (see ADR-0019).
#[tauri::command]
pub async fn git_repo_slug(cwd: String) -> Result<Option<String>, AbundioError> {
    tokio::task::spawn_blocking(move || crate::git_libgit2::github_repo_slug(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchBundle {
    pub changed_files: Vec<GitChangedFile>,
    pub branch_info: BranchInfo,
    pub status_fingerprint: String,
}

/// Single-IPC bundle for the git-tab refresh. Returns the three pieces of
/// state the frontend would otherwise fetch as three separate `invoke()`
/// calls (changedFiles + branchInfo + statusFingerprint). All three run
/// in parallel via scoped threads inside one `spawn_blocking`, so wall
/// time is max() of the three, and there is exactly one WKWebView IPC
/// round-trip per refresh — which is the dominant cost on macOS.
#[tauri::command]
pub async fn git_fetch_bundle(
    cwd: String,
    base_branch: Option<String>,
) -> Result<GitFetchBundle, AbundioError> {
    tokio::task::spawn_blocking(move || {
        let (changed_files_res, branch_info_res, fingerprint_res) = std::thread::scope(|s| {
            let h_changed =
                s.spawn(|| compute_changed_files_sync(&cwd, base_branch.clone()));
            let h_branch = s.spawn(|| compute_branch_info_sync(&cwd));
            let h_fp = s.spawn(|| compute_status_fingerprint_sync(&cwd));
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
            changed_files: changed_files_res?,
            branch_info: branch_info_res?,
            status_fingerprint: fingerprint_res?,
        })
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_file_diff(
    cwd: String,
    file_path: String,
    section: String,
    base_branch: Option<String>,
) -> Result<GitFileDiff, AbundioError> {
    tokio::task::spawn_blocking(move || {
        let base = resolve_base_branch(&cwd, base_branch.clone())?;

        // Validate file_path: must be relative and contain no ".." components
        let fp = Path::new(&file_path);
        if fp.is_absolute() || fp.components().any(|c| c == std::path::Component::ParentDir) {
            return Err(AbundioError::Git(format!(
                "Invalid file path: {}",
                file_path
            )));
        }

        let (original, modified) = match section.as_str() {
            "against_base" => {
                let original = git_libgit2::file_blob_at_rev(&cwd, &base, &file_path);
                let full_path = Path::new(&cwd).join(&file_path);
                let modified = std::fs::read_to_string(&full_path).unwrap_or_default();
                (original, modified)
            }
            "staged" => {
                let original = git_libgit2::file_blob_at_rev(&cwd, "HEAD", &file_path);
                let modified = git_libgit2::file_blob_at_index(&cwd, &file_path);
                (original, modified)
            }
            "unstaged" => {
                let original = git_libgit2::file_blob_at_index(&cwd, &file_path);
                let full_path = Path::new(&cwd).join(&file_path);
                let modified = std::fs::read_to_string(&full_path).unwrap_or_default();
                (original, modified)
            }
            "untracked" => {
                let full_path = Path::new(&cwd).join(&file_path);
                let modified = std::fs::read_to_string(&full_path).unwrap_or_default();
                (String::new(), modified)
            }
            _ => {
                return Err(AbundioError::Git(format!(
                    "Unknown section: {}",
                    section
                )));
            }
        };

        Ok(GitFileDiff {
            original,
            modified,
            file_path,
        })
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_branch_info(cwd: String) -> Result<BranchInfo, AbundioError> {
    tokio::task::spawn_blocking(move || compute_branch_info_sync(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_status_fingerprint(cwd: String) -> Result<String, AbundioError> {
    tokio::task::spawn_blocking(move || compute_status_fingerprint_sync(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_list_branches(cwd: String) -> Result<Vec<String>, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::list_branches(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRequest {
    pub workspace_id: String,
    pub cwd: String,
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitSummary {
    pub workspace_id: String,
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub changed_file_count: i32,
    pub additions: i32,
    pub deletions: i32,
    /// Stable per-repository key shared by all worktrees of one repo (the
    /// canonical common git dir). `None` when not a git repo. Drives the
    /// sidebar's Worktree set grouping. See ADR-0017.
    pub worktree_group_key: Option<String>,
    /// True when this workspace's folder is the repository's main worktree
    /// (the Primary worktree).
    pub is_main_worktree: bool,
    /// Canonicalized worktree root. Lets the live-sync reconciler compare a
    /// workspace against canonical `list_repo_worktrees` paths without a symlink
    /// mismatch (e.g. `/tmp` vs `/private/tmp`) deleting it. See ADR-0017.
    pub worktree_root: Option<String>,
}

/// Resolves just the current branch name for a workspace via libgit2.
/// Change stats are intentionally excluded — they're already computed by
/// `git_changed_files` whenever the active workspace opens its git panel,
/// which syncs back to the workspace chip store via the frontend.
fn compute_workspace_git_summary(req: WorkspaceGitRequest) -> WorkspaceGitSummary {
    let current_branch = git_libgit2::current_branch_only(&req.cwd);
    let bits = git_libgit2::worktree_summary_bits(&req.cwd);
    // A repo can be a git repo even with a detached/unborn HEAD (no branch),
    // so anchor is_git_repo on the worktree group key, not the branch name.
    let is_git_repo = bits.group_key.is_some();
    WorkspaceGitSummary {
        workspace_id: req.workspace_id,
        is_git_repo,
        current_branch,
        changed_file_count: 0,
        additions: 0,
        deletions: 0,
        worktree_group_key: bits.group_key,
        is_main_worktree: bits.is_main_worktree,
        worktree_root: bits.canonical_root,
    }
}

/// Fetch the current branch for every workspace in a single IPC call.
/// Runs inside `spawn_blocking` so the tokio runtime is never blocked.
/// Intentionally limited to branch detection only (one subprocess per
/// workspace) — running diff commands for all workspaces at startup causes
/// too many concurrent process forks and degrades overall app responsiveness.
#[tauri::command]
pub async fn git_workspaces_summary(
    requests: Vec<WorkspaceGitRequest>,
) -> Vec<WorkspaceGitSummary> {
    if requests.is_empty() {
        return Vec::new();
    }
    tokio::task::spawn_blocking(move || {
        requests
            .into_iter()
            .map(compute_workspace_git_summary)
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Minimal subprocess git for test setup. Production code is pure libgit2;
    /// tests still shell out to `git` because constructing initial commits +
    /// configs via libgit2 is verbose and there's no perf concern in tests.
    fn run_git_test(cwd: &str, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command failed to spawn");
        if !output.status.success() {
            panic!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    #[test]
    fn is_git_repo_rejects_non_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!git_libgit2::is_git_repo(dir.path().to_str().unwrap()));
    }

    #[test]
    fn is_git_repo_accepts_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["init"]);
        assert!(git_libgit2::is_git_repo(cwd));
    }

    /// Helper: create a temporary git repo with an initial commit.
    fn setup_temp_git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["init"]);
        run_git_test(cwd, &["config", "user.email", "test@test.com"]);
        run_git_test(cwd, &["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("initial.txt"), "hello\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn has_github_remote_false_without_remote() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        assert!(!crate::git_libgit2::has_github_remote(cwd));
    }

    #[test]
    fn has_github_remote_false_for_non_github_remote() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://gitlab.com/me/repo.git"]);
        assert!(!crate::git_libgit2::has_github_remote(cwd));
    }

    #[test]
    fn has_github_remote_true_for_https_and_ssh() {
        for url in [
            "https://github.com/me/repo.git",
            "git@github.com:me/repo.git",
        ] {
            let dir = setup_temp_git_repo();
            let cwd = dir.path().to_str().unwrap();
            run_git_test(cwd, &["remote", "add", "origin", url]);
            assert!(
                crate::git_libgit2::has_github_remote(cwd),
                "expected github remote detected for {url}"
            );
        }
    }

    #[test]
    fn has_github_remote_false_for_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!crate::git_libgit2::has_github_remote(
            dir.path().to_str().unwrap()
        ));
    }

    #[tokio::test]
    async fn git_changed_files_includes_untracked() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();

        // Create an untracked file with 3 lines
        std::fs::write(dir.path().join("new_file.txt"), "a\nb\nc\n").unwrap();

        let files = git_changed_files(cwd.to_string(), Some("main".to_string())).await.unwrap();
        let untracked: Vec<_> = files.iter().filter(|f| f.section == "untracked").collect();

        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0].path, "new_file.txt");
        assert_eq!(untracked[0].status, "?");
        assert_eq!(untracked[0].additions, 3); // new file: whole content counts as additions (git numstat semantics)
        assert_eq!(untracked[0].deletions, 0);
    }

    #[tokio::test]
    async fn git_file_diff_untracked_returns_empty_original() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();

        std::fs::write(dir.path().join("untracked.txt"), "line1\nline2\n").unwrap();

        let diff = git_file_diff(
            cwd.to_string(),
            "untracked.txt".to_string(),
            "untracked".to_string(),
            Some("main".to_string()),
        )
        .await
        .unwrap();

        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "line1\nline2\n");
        assert_eq!(diff.file_path, "untracked.txt");
    }
}

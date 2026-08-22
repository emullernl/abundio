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

/// Line/file churn between two worktree snapshots — a per-Turn working-tree
/// diff (see ADR-0021). Each field is independently non-negative.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeDiffStats {
    pub additions: i64,
    pub deletions: i64,
    pub files: i64,
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

/// Snapshot the worktree to a tree OID for per-Turn churn measurement (ADR-0021).
/// Best-effort: returns null for a non-git workspace. Never touches the on-disk
/// staging area (see `git_libgit2::snapshot_worktree_tree`).
#[tauri::command]
pub async fn git_snapshot_worktree(cwd: String) -> Result<Option<String>, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::snapshot_worktree_tree(&cwd))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

/// Line/file churn between two worktree tree snapshots (per-Turn working-tree
/// diff). See ADR-0021.
#[tauri::command]
pub async fn git_diff_trees(
    cwd: String,
    start_oid: String,
    end_oid: String,
) -> Result<TreeDiffStats, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::diff_tree_stats(&cwd, &start_oid, &end_oid))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub file_path: String,
    /// Which stages exist: both_modified | deleted_by_us | deleted_by_them |
    /// both_added | added_by_us | added_by_them | none. A pure discriminator —
    /// the UI never renders it, because naming a side is wrong half the time
    /// during a rebase (see ADR-0029).
    pub kind: String,
    pub is_binary: bool,
    /// Stage 1/2/3 as text, or `None` when that stage is absent or the file is
    /// binary. Deliberately no merged text: the pane owns that buffer, and a
    /// second copy from Rust would immediately diverge from the user's edits.
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchBundle {
    pub changed_files: Vec<GitChangedFile>,
    pub branch_info: BranchInfo,
    pub status_fingerprint: String,
    /// The suspended multi-step git operation, if any: "merge" | "rebase" |
    /// "cherry_pick" | "revert". Read-only — Abundio never continues or aborts
    /// one, it only says that finishing it is still the user's move.
    pub operation_in_progress: Option<String>,
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
        let (changed_files_res, branch_info_res, fingerprint_res, op_res) =
            std::thread::scope(|s| {
            let h_changed =
                s.spawn(|| compute_changed_files_sync(&cwd, base_branch.clone()));
            let h_branch = s.spawn(|| compute_branch_info_sync(&cwd));
            let h_fp = s.spawn(|| compute_status_fingerprint_sync(&cwd));
            let h_op = s.spawn(|| git_libgit2::compute_operation_in_progress_sync(&cwd));
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
            )
        });
        Ok(GitFetchBundle {
            changed_files: changed_files_res?,
            branch_info: branch_info_res?,
            status_fingerprint: fingerprint_res?,
            // Best-effort: a repo we can't read the state of shows no line
            // rather than failing the whole bundle.
            operation_in_progress: op_res.unwrap_or(None),
        })
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

/// Reject anything that isn't a plain repository-relative path.
///
/// Shared by every command that turns a caller-supplied path into a filesystem
/// or index lookup. `git_stage_path` *writes* through this, so it must not grow
/// its own copy — one validator, one set of rules.
fn validate_repo_relative(file_path: &str) -> Result<(), AbundioError> {
    // Every component must be a plain name. Allow-listing rather than rejecting
    // `is_absolute()` + `ParentDir` matters on Windows, where `C:foo` is
    // *drive-relative* — `is_absolute()` is false, so the old check passed it,
    // yet `workdir.join("C:foo")` discards the workdir entirely because the
    // pushed path carries a prefix. This validator stands in front of the
    // codebase's only index write, so it should not lean on libgit2 rejecting
    // such a path downstream.
    let fp = Path::new(file_path);
    let mut components = fp.components().peekable();
    if components.peek().is_none() {
        return Err(AbundioError::Git("Invalid file path: empty".to_string()));
    }
    if !components.all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(AbundioError::Git(format!("Invalid file path: {}", file_path)));
    }
    Ok(())
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

        validate_repo_relative(&file_path)?;

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
            // Conflicted rows open a text pane, not a diff, so nothing should
            // reach this arm — but a stray `diffSection: "conflicted"` from a
            // restored layout degrades to a readable ours/theirs diff instead of
            // failing silently in the caller's bare `catch`.
            "conflicted" => {
                let conflict = git_libgit2::compute_conflict_file_sync(&cwd, &file_path)?;
                (
                    conflict.ours.unwrap_or_default(),
                    conflict.theirs.unwrap_or_default(),
                )
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

/// The conflict stages of an unmerged path.
///
/// The inline resolution UX needs none of these — the working-tree file already
/// carries both sides in its markers. This exists for what the markers cannot
/// answer: the conflict *kind* (delete/modify, add/add), binary detection, and
/// the side content the Merge view shows.
#[tauri::command]
pub async fn git_conflict_file(
    cwd: String,
    file_path: String,
) -> Result<GitConflictFile, AbundioError> {
    tokio::task::spawn_blocking(move || {
        validate_repo_relative(&file_path)?;
        git_libgit2::compute_conflict_file_sync(&cwd, &file_path)
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

/// `git add <path>` — Abundio's only write to git.
///
/// Note the caller must refresh the Git changes tab itself: `.git/index` is
/// deliberately excluded from the file watcher's meaningful-change set (read-only
/// git commands touch it constantly), so the scheduler will not observe this.
#[tauri::command]
pub async fn git_stage_path(cwd: String, file_path: String) -> Result<(), AbundioError> {
    tokio::task::spawn_blocking(move || {
        validate_repo_relative(&file_path)?;
        git_libgit2::stage_path_sync(&cwd, &file_path)
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
    /// Every GitHub `owner/repo` this workspace's remotes point at (empty when
    /// there are none). Feeds the Profile-scoped PR filter, which is a
    /// set-membership test — hence all remotes, not just `origin`. See ADR-0028.
    pub repo_slugs: Vec<String>,
}

/// Resolves the cheap per-workspace git facts via libgit2: current branch,
/// worktree grouping bits, and GitHub repo identity. All three are config/HEAD
/// reads on **one** open repository — the `_in` variants exist so this batch,
/// which runs across the whole Profile on every workspace-list change, pays for
/// a single `Repository::discover` per workspace rather than one each.
/// Change stats are intentionally excluded — they're already computed by
/// `git_changed_files` whenever the active workspace opens its git panel,
/// which syncs back to the workspace chip store via the frontend.
fn compute_workspace_git_summary(req: WorkspaceGitRequest) -> WorkspaceGitSummary {
    let repo = git2::Repository::discover(&req.cwd).ok();
    let current_branch = repo.as_ref().and_then(git_libgit2::current_branch_only_in);
    let bits = match repo.as_ref() {
        Some(r) => git_libgit2::worktree_summary_bits_in(r),
        None => git_libgit2::WorktreeSummaryBits {
            group_key: None,
            is_main_worktree: false,
            canonical_root: None,
        },
    };
    let repo_slugs = repo
        .as_ref()
        .map(git_libgit2::github_repo_slugs_in)
        .unwrap_or_default();
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
        repo_slugs,
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
    /// Like `run_git_test`, but tolerates a non-zero exit.
    ///
    /// Needed because `git merge` exits 1 when it stops on a conflict — the
    /// whole point of the conflict fixtures — and `run_git_test` panics on that.
    fn run_git_test_allow_fail(cwd: &str, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command failed to spawn")
    }

    fn init_repo_test(cwd: &str) {
        run_git_test(cwd, &["init", "-b", "main"]);
        run_git_test(cwd, &["config", "user.email", "t@example.com"]);
        run_git_test(cwd, &["config", "user.name", "T"]);
        run_git_test(cwd, &["config", "commit.gpgsign", "false"]);
    }

    /// A repo stopped mid-merge with `file.txt` unmerged (base/ours/theirs =
    /// "base\n"/"ours\n"/"theirs\n") and `calm.txt` committed and untouched.
    fn make_conflicted_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);

        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        std::fs::write(dir.path().join("calm.txt"), "calm\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "base"]);

        run_git_test(cwd, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("file.txt"), "ours\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "ours"]);

        run_git_test(cwd, &["checkout", "main"]);
        std::fs::write(dir.path().join("file.txt"), "theirs\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "theirs"]);

        run_git_test(cwd, &["checkout", "feature"]);
        let out = run_git_test_allow_fail(cwd, &["merge", "main"]);
        assert!(!out.status.success(), "merge was expected to conflict");
        dir
    }

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

    #[test]
    fn repo_slugs_empty_without_github_remote() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        assert!(git_libgit2::github_repo_slugs(cwd).is_empty());

        run_git_test(cwd, &["remote", "add", "origin", "https://gitlab.com/me/repo.git"]);
        assert!(git_libgit2::github_repo_slugs(cwd).is_empty());
    }

    /// A fork checkout: `origin` is the fork, `upstream` the base repo. Both
    /// must be collected or the Profile-scoped PR filter would hide PRs opened
    /// against the base repo. See ADR-0028.
    #[test]
    fn repo_slugs_collects_every_github_remote_origin_first() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "upstream", "git@github.com:acme/foo.git"]);
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/me/foo.git"]);
        run_git_test(cwd, &["remote", "add", "mirror", "https://gitlab.com/me/foo.git"]);

        assert_eq!(
            git_libgit2::github_repo_slugs(cwd),
            vec!["me/foo".to_string(), "acme/foo".to_string()]
        );
    }

    /// Same repo reachable through two remotes (or a separate push URL) must
    /// appear once — the frontend builds a Set from these anyway, but keeping
    /// the vec clean makes the store's dedup a no-op rather than a crutch.
    #[test]
    fn repo_slugs_deduplicates() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/me/foo.git"]);
        run_git_test(cwd, &["remote", "add", "second", "git@github.com:me/foo.git"]);

        assert_eq!(
            git_libgit2::github_repo_slugs(cwd),
            vec!["me/foo".to_string()]
        );
    }

    #[tokio::test]
    async fn workspaces_summary_carries_repo_slugs() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/me/foo.git"]);

        let summaries = git_workspaces_summary(vec![WorkspaceGitRequest {
            workspace_id: "ws-1".to_string(),
            cwd: cwd.to_string(),
            base_branch: None,
        }])
        .await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].repo_slugs, vec!["me/foo".to_string()]);
    }

    #[tokio::test]
    async fn workspaces_summary_repo_slugs_empty_for_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let summaries = git_workspaces_summary(vec![WorkspaceGitRequest {
            workspace_id: "ws-1".to_string(),
            cwd: dir.path().to_str().unwrap().to_string(),
            base_branch: None,
        }])
        .await;

        assert!(summaries[0].repo_slugs.is_empty());
        assert!(!summaries[0].is_git_repo);
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

    #[test]
    fn conflicted_section_lists_the_unmerged_path_once() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();

        let conflicted: Vec<_> = files
            .iter()
            .filter(|f| f.section == "conflicted")
            .collect();
        assert_eq!(conflicted.len(), 1, "got {files:#?}");
        assert_eq!(conflicted[0].path, "file.txt");
        assert_eq!(conflicted[0].status, "U");
        assert_eq!(conflicted[0].additions, 0);
        assert_eq!(conflicted[0].deletions, 0);

        // Deduped out of the three worktree/index sections: an unmerged path
        // has no stage 0, so it has no honest entry there.
        for section in ["staged", "unstaged", "untracked"] {
            assert!(
                !files
                    .iter()
                    .any(|f| f.section == section && f.path == "file.txt"),
                "file.txt should not appear in {section}: {files:#?}"
            );
        }
    }

    #[test]
    fn conflicted_section_is_ordered_first() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(files.first().map(|f| f.section.as_str()), Some("conflicted"));
    }

    #[test]
    fn against_base_still_lists_a_conflicted_path() {
        // Deliberate: against_base compares committed history on a different
        // axis. Dropping the path would silently shrink the branch review
        // mid-merge and restore it afterwards.
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();
        assert!(
            files
                .iter()
                .any(|f| f.section == "against_base" && f.path == "file.txt"),
            "expected file.txt under against_base: {files:#?}"
        );
    }

    #[test]
    fn unconflicted_files_are_untouched_by_the_dedup() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("calm.txt"), "edited\n").unwrap();
        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();
        assert!(
            files
                .iter()
                .any(|f| f.section == "unstaged" && f.path == "calm.txt"),
            "calm.txt should still show as unstaged: {files:#?}"
        );
    }

    #[test]
    fn clean_repo_has_no_conflicted_section() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "init"]);

        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();
        assert!(!files.iter().any(|f| f.section == "conflicted"));
    }

    #[test]
    fn fingerprint_changes_when_a_conflict_is_resolved() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let before = git_libgit2::compute_status_fingerprint_sync(cwd).unwrap();
        std::fs::write(dir.path().join("file.txt"), "resolved\n").unwrap();
        run_git_test(cwd, &["add", "file.txt"]);
        let after = git_libgit2::compute_status_fingerprint_sync(cwd).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn operation_in_progress_reports_merge_then_clears() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        assert_eq!(
            git_libgit2::compute_operation_in_progress_sync(cwd).unwrap(),
            Some("merge".to_string())
        );
        run_git_test(cwd, &["merge", "--abort"]);
        assert_eq!(
            git_libgit2::compute_operation_in_progress_sync(cwd).unwrap(),
            None
        );
    }

    #[test]
    fn conflict_in_a_linked_worktree_is_seen() {
        // libgit2 resolves the per-worktree gitdir, so both the conflicted
        // section and the operation state must be correct here.
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "base"]);
        run_git_test(cwd, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("file.txt"), "ours\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "ours"]);
        run_git_test(cwd, &["checkout", "main"]);
        std::fs::write(dir.path().join("file.txt"), "theirs\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "theirs"]);

        let linked = dir.path().join("wt");
        let linked_s = linked.to_str().unwrap();
        run_git_test(cwd, &["worktree", "add", linked_s, "feature"]);
        let out = run_git_test_allow_fail(linked_s, &["merge", "main"]);
        assert!(!out.status.success(), "merge was expected to conflict");

        let files =
            git_libgit2::compute_changed_files_sync(linked_s, Some("main".into())).unwrap();
        assert!(
            files
                .iter()
                .any(|f| f.section == "conflicted" && f.path == "file.txt"),
            "linked worktree conflict not seen: {files:#?}"
        );
        assert_eq!(
            git_libgit2::compute_operation_in_progress_sync(linked_s).unwrap(),
            Some("merge".to_string())
        );
    }

    #[test]
    fn conflict_file_returns_all_three_stages() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let c = git_libgit2::compute_conflict_file_sync(cwd, "file.txt").unwrap();
        assert_eq!(c.kind, "both_modified");
        assert!(!c.is_binary);
        assert_eq!(c.base.as_deref(), Some("base\n"));
        assert_eq!(c.ours.as_deref(), Some("ours\n"));
        assert_eq!(c.theirs.as_deref(), Some("theirs\n"));
    }

    #[test]
    fn conflict_file_reports_none_for_a_merged_path() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let c = git_libgit2::compute_conflict_file_sync(cwd, "calm.txt").unwrap();
        assert_eq!(c.kind, "none");
        assert!(c.base.is_none() && c.ours.is_none() && c.theirs.is_none());
    }

    #[test]
    fn delete_conflict_reports_a_missing_side() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "base"]);

        run_git_test(cwd, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("file.txt"), "edited\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "edit"]);

        run_git_test(cwd, &["checkout", "main"]);
        run_git_test(cwd, &["rm", "file.txt"]);
        run_git_test(cwd, &["commit", "-m", "remove"]);

        run_git_test(cwd, &["checkout", "feature"]);
        let out = run_git_test_allow_fail(cwd, &["merge", "main"]);
        assert!(!out.status.success());

        let c = git_libgit2::compute_conflict_file_sync(cwd, "file.txt").unwrap();
        assert_eq!(c.kind, "deleted_by_them");
        assert!(c.theirs.is_none());
        assert_eq!(c.ours.as_deref(), Some("edited\n"));
    }

    #[test]
    fn binary_conflict_sets_is_binary_and_omits_text() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        let bin = |b: u8| vec![0u8, 1, 2, b, 0, 9];
        std::fs::write(dir.path().join("blob.bin"), bin(3)).unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "base"]);

        run_git_test(cwd, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("blob.bin"), bin(7)).unwrap();
        run_git_test(cwd, &["commit", "-am", "ours"]);

        run_git_test(cwd, &["checkout", "main"]);
        std::fs::write(dir.path().join("blob.bin"), bin(11)).unwrap();
        run_git_test(cwd, &["commit", "-am", "theirs"]);

        run_git_test(cwd, &["checkout", "feature"]);
        let out = run_git_test_allow_fail(cwd, &["merge", "main"]);
        assert!(!out.status.success());

        let c = git_libgit2::compute_conflict_file_sync(cwd, "blob.bin").unwrap();
        assert!(c.is_binary, "expected a binary conflict: {c:#?}");
        assert!(c.base.is_none() && c.ours.is_none() && c.theirs.is_none());
    }

    #[test]
    fn stage_path_clears_the_conflict() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("file.txt"), "resolved\n").unwrap();

        git_libgit2::stage_path_sync(cwd, "file.txt").unwrap();

        let repo = git2::Repository::open(cwd).unwrap();
        assert!(!repo.index().unwrap().has_conflicts());

        let files = git_libgit2::compute_changed_files_sync(cwd, Some("main".into())).unwrap();
        assert!(!files.iter().any(|f| f.section == "conflicted"));
        assert!(files
            .iter()
            .any(|f| f.section == "staged" && f.path == "file.txt"));
    }

    #[test]
    fn stage_path_on_a_missing_file_stages_the_deletion() {
        // This is how "accept the delete" works for a delete/modify conflict:
        // remove the file, then stage the path.
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();

        git_libgit2::stage_path_sync(cwd, "file.txt").unwrap();

        let repo = git2::Repository::open(cwd).unwrap();
        let index = repo.index().unwrap();
        assert!(!index.has_conflicts());
        assert!(index.get_path(std::path::Path::new("file.txt"), 0).is_none());
    }

    #[test]
    fn stage_path_rejects_escaping_paths() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let index_path = dir.path().join(".git").join("index");
        let before = std::fs::read(&index_path).unwrap();

        assert!(git_libgit2::stage_path_sync(cwd, "file.txt").is_ok());
        // The validator lives in the command layer, so assert through it.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert!(rt
            .block_on(git_stage_path(cwd.to_string(), "/etc/passwd".to_string()))
            .is_err());
        assert!(rt
            .block_on(git_stage_path(cwd.to_string(), "../escape".to_string()))
            .is_err());
        // Only the legitimate stage above changed the index.
        assert_ne!(before, std::fs::read(&index_path).unwrap());
    }

    #[test]
    fn file_diff_conflicted_section_falls_back_to_ours_vs_theirs() {
        let dir = make_conflicted_repo();
        let cwd = dir.path().to_str().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let diff = rt
            .block_on(git_file_diff(
                cwd.to_string(),
                "file.txt".to_string(),
                "conflicted".to_string(),
                Some("main".to_string()),
            ))
            .unwrap();
        assert_eq!(diff.original, "ours\n");
        assert_eq!(diff.modified, "theirs\n");
    }

    #[test]
    fn validate_repo_relative_rejects_escapes() {
        assert!(validate_repo_relative("src/main.rs").is_ok());
        assert!(validate_repo_relative("a/b/c.txt").is_ok());
        assert!(validate_repo_relative("/etc/passwd").is_err());
        assert!(validate_repo_relative("../outside.txt").is_err());
        assert!(validate_repo_relative("src/../../escape.txt").is_err());
    }

    #[test]
    fn validate_repo_relative_accepts_only_plain_components() {
        // `./foo` and an empty path are not things git hands us, and this guards
        // the only index write in the codebase — so anything that is not a plain
        // name is refused rather than normalised.
        assert!(validate_repo_relative("").is_err());
        assert!(validate_repo_relative("./src/main.rs").is_err());
        assert!(validate_repo_relative(".").is_err());
        // Drive-relative on Windows: `is_absolute()` is false there, so the old
        // is_absolute + ParentDir check let it through.
        #[cfg(windows)]
        {
            assert!(validate_repo_relative("C:foo").is_err());
            assert!(validate_repo_relative("C:\\foo").is_err());
            assert!(validate_repo_relative("\\\\server\\share\\f").is_err());
        }
    }

}

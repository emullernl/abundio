use crate::error::AbundioError;
use crate::git_libgit2;
use std::path::Path;

pub use crate::git_core::*;


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
        let (changed_files_res, branch_info_res, fingerprint_res, op_res, commits_res) =
            std::thread::scope(|s| {
            let h_changed =
                s.spawn(|| compute_changed_files_sync(&cwd, base_branch.clone()));
            let h_commits = s.spawn(|| {
                git_libgit2::compute_commit_history_sync(&cwd, base_branch.clone())
            });
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
                h_commits
                    .join()
                    .unwrap_or_else(|_| Err(AbundioError::Git("branch commits panic".into()))),
            )
        });
        Ok(GitFetchBundle {
            changed_files: changed_files_res?,
            branch_info: branch_info_res?,
            status_fingerprint: fingerprint_res?,
            // Best-effort: a repo we can't read the state of shows no line
            // rather than failing the whole bundle.
            operation_in_progress: op_res.unwrap_or(None),
            commit_history: commits_res.ok(),
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

/// The files one commit touched, against its first parent (a root commit
/// against the empty tree). Commits are immutable, so the frontend caches this.
#[tauri::command]
pub async fn git_commit_files(cwd: String, oid: String) -> Result<Vec<CommitFile>, AbundioError> {
    tokio::task::spawn_blocking(move || git_libgit2::commit_files_sync(&cwd, &oid))
        .await
        .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

/// One file as a single commit changed it: first parent → commit. Feeds the
/// read-only **Commit diff pane**, which is never re-read from disk.
#[tauri::command]
pub async fn git_commit_file_diff(
    cwd: String,
    oid: String,
    file_path: String,
) -> Result<GitFileDiff, AbundioError> {
    tokio::task::spawn_blocking(move || {
        validate_repo_relative(&file_path)?;
        let (original, modified) = git_libgit2::commit_file_diff_sync(&cwd, &oid, &file_path)?;
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

/// Fetch the cheap git facts for every workspace in a single IPC call: branch,
/// worktree grouping, repo slugs and working-tree dirtiness.
///
/// Still no diffs — line counts stay with the per-workspace scheduler — but
/// dirtiness makes each request a working-tree status walk, so the requests run
/// on **one `spawn_blocking` task each** rather than serially inside one. The
/// per-workspace work is independent and CPU/IO bound, so a Profile with a dozen
/// large repos no longer pays for a dozen sequential scans. The tokio runtime
/// itself is never blocked either way.
///
/// A workspace whose task panics is simply absent from the result: callers
/// already treat a missing entry as "no answer for this one".
#[tauri::command]
pub async fn git_workspaces_summary(
    requests: Vec<WorkspaceGitRequest>,
) -> Vec<WorkspaceGitSummary> {
    if requests.is_empty() {
        return Vec::new();
    }
    let mut tasks = tokio::task::JoinSet::new();
    for req in requests {
        tasks.spawn_blocking(move || compute_workspace_git_summary(req));
    }
    let mut summaries = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        if let Ok(summary) = joined {
            summaries.push(summary);
        }
    }
    summaries
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
    async fn workspaces_summary_reports_dirty_working_tree() {
        let dir = setup_temp_git_repo();
        let cwd = dir.path().to_str().unwrap();
        let summarize = || {
            git_workspaces_summary(vec![WorkspaceGitRequest {
                workspace_id: "ws-1".to_string(),
                cwd: cwd.to_string(),
                base_branch: None,
            }])
        };

        assert!(!summarize().await[0].is_dirty, "fresh commit is clean");

        std::fs::write(dir.path().join("initial.txt"), "changed\n").unwrap();
        assert!(summarize().await[0].is_dirty, "unstaged edit is dirty");

        run_git_test(cwd, &["commit", "-am", "second"]);
        assert!(!summarize().await[0].is_dirty, "committed work is clean");
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
        assert!(!summaries[0].is_dirty);
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

    /// main: `base`; feature: `one`, `two` (two edits `a.txt`, adds `b.txt`).
    fn make_branch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        std::fs::write(dir.path().join("a.txt"), "base\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "base"]);
        run_git_test(cwd, &["checkout", "-b", "feature"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        run_git_test(cwd, &["commit", "-am", "one"]);
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "new\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "two\n\nbody line"]);
        dir
    }

    fn subjects(h: &CommitHistory) -> Vec<(&str, bool)> {
        h.commits.iter().map(|c| (c.subject.as_str(), c.shared)).collect()
    }

    #[test]
    fn commit_history_lists_ahead_then_shared_history() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.base.as_deref(), Some("main"));
        assert_eq!(h.ahead, 2);
        assert_eq!(subjects(&h), [("two", false), ("one", false), ("base", true)]);
        assert_eq!(h.commits[0].message, "two\n\nbody line");
        assert_eq!(h.commits[0].author_name, "T");
    }

    #[test]
    fn commit_history_on_the_base_branch_is_its_latest_commits() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["checkout", "main"]);
        run_git_test(cwd, &["commit", "--allow-empty", "-m", "main2"]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.ahead, 0);
        // Everything is shared: the UI draws no divider above the first row.
        assert_eq!(subjects(&h), [("main2", true), ("base", true)]);
    }

    #[test]
    fn commit_history_shows_the_base_as_the_branch_last_saw_it() {
        // main moves on after the branch left it; those commits are not in
        // the Workspace and must not be listed.
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["checkout", "main"]);
        run_git_test(cwd, &["commit", "--allow-empty", "-m", "later on main"]);
        run_git_test(cwd, &["checkout", "feature"]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(subjects(&h), [("two", false), ("one", false), ("base", true)]);
    }

    #[test]
    fn commit_history_does_not_interleave_when_the_base_was_merged_in() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["checkout", "main"]);
        run_git_test(cwd, &["commit", "--allow-empty", "-m", "main2"]);
        run_git_test(cwd, &["checkout", "feature"]);
        run_git_test(cwd, &["merge", "--no-ff", "-m", "merge main", "main"]);
        run_git_test(cwd, &["commit", "--allow-empty", "-m", "three"]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        // The merge is ahead; main2 is shared now (the merge-base moved up).
        assert_eq!(h.ahead, 4);
        let s = subjects(&h);
        let first_shared = s.iter().position(|(_, shared)| *shared).unwrap();
        assert!(s[..first_shared].iter().all(|(_, shared)| !shared));
        assert!(s[first_shared..].iter().all(|(_, shared)| *shared));
        assert_eq!(s[first_shared].0, "main2");
        assert!(h.commits.iter().any(|c| c.is_merge && !c.shared));
    }

    #[test]
    fn commit_history_never_lists_a_parent_before_its_child_on_a_time_tie() {
        // Every commit below has the same committer and author second, so
        // time order alone is free to put a parent first.
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        init_repo_test(cwd);
        for i in 0..12 {
            let out = Command::new("git")
                .args(["commit", "--allow-empty", "-m", &format!("c{i}")])
                .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("nope".into())).unwrap();
        let subjects: Vec<_> = h.commits.iter().map(|c| c.subject.clone()).collect();
        let want: Vec<_> = (0..12).rev().map(|i| format!("c{i}")).collect();
        assert_eq!(subjects, want);
    }

    #[test]
    fn commit_history_with_an_unknown_base_is_plain_head_history() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("nope".into())).unwrap();
        assert_eq!(h.base, None);
        assert_eq!(h.ahead, 0);
        assert_eq!(subjects(&h), [("two", false), ("one", false), ("base", false)]);
    }

    #[test]
    fn commit_history_caps_rows_but_not_the_ahead_count() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let extra = git_libgit2::COMMIT_HISTORY_CAP + 3;
        for i in 0..extra {
            run_git_test(cwd, &["commit", "--allow-empty", "-m", &format!("e{i}")]);
        }
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.ahead, extra + 2);
        assert_eq!(h.commits.len(), git_libgit2::COMMIT_HISTORY_CAP);
        // All ahead: no shared row fits.
        assert!(h.commits.iter().all(|c| !c.shared));
    }

    #[test]
    fn commit_history_marks_commits_the_github_remote_reaches() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let one = run_git_test(cwd, &["rev-parse", "HEAD~1"]).trim().to_string();
        // Simulate `origin/feature` having been pushed at `one`.
        run_git_test(cwd, &["update-ref", "refs/remotes/origin/feature", &one]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.github_slug.as_deref(), Some("o/r"));
        let by = |s: &str| h.commits.iter().find(|c| c.subject == s).unwrap();
        assert!(!by("two").on_remote);
        assert!(by("one").on_remote);
        // Shared history below a pushed commit is pushed too.
        assert!(by("base").on_remote);
    }

    #[test]
    fn commit_history_shared_rows_on_an_unpushed_base_are_not_on_remote() {
        // Local main carries a commit nobody pushed; being below the divider
        // must not make it linkable.
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let base = run_git_test(cwd, &["rev-parse", "main"]).trim().to_string();
        run_git_test(cwd, &["update-ref", "refs/remotes/origin/main", &base]);
        run_git_test(cwd, &["checkout", "main"]);
        run_git_test(cwd, &["commit", "--allow-empty", "-m", "local only"]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        let by = |s: &str| h.commits.iter().find(|c| c.subject == s).unwrap();
        assert!(by("local only").shared);
        assert!(!by("local only").on_remote);
        assert!(by("base").on_remote);
    }

    #[test]
    fn commit_history_never_on_remote_without_a_github_remote() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://gitlab.com/o/r.git"]);
        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        run_git_test(cwd, &["update-ref", "refs/remotes/origin/feature", &head]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.github_slug, None);
        assert!(h.commits.iter().all(|c| !c.on_remote));
    }

    #[test]
    fn commit_history_judges_pushed_against_the_linked_remote_only() {
        // A fork checkout: the link goes to origin, so a commit only upstream
        // has is not "on remote" — its origin page would not exist.
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/me/r.git"]);
        run_git_test(cwd, &["remote", "add", "upstream", "https://github.com/org/r.git"]);
        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        run_git_test(cwd, &["update-ref", "refs/remotes/upstream/feature", &head]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(h.github_slug.as_deref(), Some("me/r"));
        assert!(h.commits.iter().all(|c| !c.on_remote));
    }

    #[test]
    fn commit_history_recomputes_when_head_base_or_remote_moves() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let get = || git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert_eq!(get().ahead, 2);
        assert_eq!(get().ahead, 2); // served from the cache

        run_git_test(cwd, &["commit", "--allow-empty", "-m", "three"]);
        let h = get();
        assert_eq!(h.ahead, 3);
        assert_eq!(h.commits[0].subject, "three");
        assert!(!h.commits[0].on_remote);

        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        run_git_test(cwd, &["update-ref", "refs/remotes/origin/feature", &head]);
        assert!(get().commits.iter().all(|c| c.on_remote));

        let one = run_git_test(cwd, &["rev-parse", "HEAD~1"]).trim().to_string();
        run_git_test(cwd, &["update-ref", "refs/heads/main", &one]);
        assert_eq!(get().ahead, 1);
    }

    #[test]
    fn commit_history_merge_files_are_against_the_first_parent() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        run_git_test(cwd, &["checkout", "-b", "side", "main"]);
        std::fs::write(dir.path().join("c.txt"), "side\n").unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "side"]);
        run_git_test(cwd, &["checkout", "feature"]);
        run_git_test(cwd, &["merge", "--no-ff", "-m", "merge side", "side"]);
        let h = git_libgit2::compute_commit_history_sync(cwd, Some("main".into())).unwrap();
        assert!(h.commits[0].is_merge);
        let files = git_libgit2::commit_files_sync(cwd, &h.commits[0].oid).unwrap();
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["c.txt"]);
    }

    #[test]
    fn commit_files_flag_a_submodule_bump() {
        // A gitlink written straight into the index: no nested repository or
        // network needed, and it is exactly what `git submodule update` +
        // commit records.
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let fake = "1234567890abcdef1234567890abcdef12345678";
        run_git_test(
            cwd,
            &["update-index", "--add", "--cacheinfo", &format!("160000,{fake},vendor/lib")],
        );
        run_git_test(cwd, &["commit", "-m", "add submodule"]);
        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        let files = git_libgit2::commit_files_sync(cwd, &head).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "vendor/lib");
        assert!(files[0].is_submodule);
        assert!(!files[0].is_binary);
        // Ordinary files are not submodules.
        let two = run_git_test(cwd, &["rev-parse", "HEAD~1"]).trim().to_string();
        let files = git_libgit2::commit_files_sync(cwd, &two).unwrap();
        assert!(files.iter().all(|f| !f.is_submodule));
    }

    #[test]
    fn commit_files_flag_binary_blobs() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("img.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
        run_git_test(cwd, &["add", "."]);
        run_git_test(cwd, &["commit", "-m", "binary"]);
        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        let files = git_libgit2::commit_files_sync(cwd, &head).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].is_binary);
        // And a text file is not.
        let two = run_git_test(cwd, &["rev-parse", "HEAD~1"]).trim().to_string();
        let files = git_libgit2::commit_files_sync(cwd, &two).unwrap();
        assert!(files.iter().all(|f| !f.is_binary));
    }

    #[test]
    fn commit_files_and_diff_are_first_parent_to_commit() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let head = run_git_test(cwd, &["rev-parse", "HEAD"]).trim().to_string();
        let files = git_libgit2::commit_files_sync(cwd, &head).unwrap();
        let summary: Vec<_> = files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str(), f.additions, f.deletions))
            .collect();
        assert_eq!(summary, [("a.txt", "M", 1, 1), ("b.txt", "A", 1, 0)]);

        let (orig, modi) = git_libgit2::commit_file_diff_sync(cwd, &head, "a.txt").unwrap();
        assert_eq!((orig.as_str(), modi.as_str()), ("one\n", "two\n"));
        let (orig, modi) = git_libgit2::commit_file_diff_sync(cwd, &head, "b.txt").unwrap();
        assert_eq!((orig.as_str(), modi.as_str()), ("", "new\n"));
    }

    #[test]
    fn commit_files_of_a_root_commit_diff_against_nothing() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        let root = run_git_test(cwd, &["rev-list", "--max-parents=0", "HEAD"])
            .trim()
            .to_string();
        let files = git_libgit2::commit_files_sync(cwd, &root).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "A");
    }

    #[test]
    fn commit_commands_reject_a_malformed_id() {
        let dir = make_branch_repo();
        let cwd = dir.path().to_str().unwrap();
        assert!(git_libgit2::commit_files_sync(cwd, "not-a-sha").is_err());
        assert!(git_libgit2::commit_file_diff_sync(cwd, "zz", "a.txt").is_err());
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

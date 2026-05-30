/// In-process git via libgit2 (`git2` crate). Replaces the `Command::new("git")`
/// subprocess-based implementations in `git_commands.rs` for the three
/// hot-path operations the `GitScheduler` uses on every fs/git event:
///   - `compute_status_fingerprint_sync`
///   - `compute_branch_info_sync`
///   - `compute_changed_files_sync`
///
/// Why: each subprocess git invocation took ~200-500 ms on macOS (fork + exec
/// + git startup), and the scheduler runs all three on every meaningful
/// change. While the host process is doing that work, the WKWebView's
/// WebContent process is held back enough to produce visible main-thread
/// stalls in the JS event loop. Moving to in-process libgit2 cuts each
/// operation to ~10-50 ms.
///
/// The public function signatures match the subprocess versions byte-for-byte
/// (same struct shapes, same return types) so `git_commands.rs` can swap them
/// in without touching its callers (the `#[tauri::command]` wrappers,
/// `git_scheduler.rs`, etc.).
use std::collections::HashMap;

use dashmap::DashMap;
use git2::{Delta, Diff, DiffOptions, ErrorCode, Repository, Status, StatusOptions};

use crate::error::AbundioError;
use crate::git_commands::{BranchInfo, GitChangedFile};

const MAX_UNTRACKED: usize = 500;

fn default_branch_cache() -> &'static DashMap<String, String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<DashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

fn open_repo(cwd: &str) -> Result<Repository, AbundioError> {
    Repository::discover(cwd).map_err(|e| match e.code() {
        ErrorCode::NotFound => AbundioError::NotGitRepo(cwd.to_string()),
        _ => AbundioError::Git(format!("open repo: {e}")),
    })
}

pub fn compute_status_fingerprint_sync(cwd: &str) -> Result<String, AbundioError> {
    let repo = open_repo(cwd)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AbundioError::Git(format!("statuses: {e}")))?;

    // Build a deterministic fingerprint. The exact format doesn't need to
    // match `git status --porcelain`; it just needs to change iff the
    // working-tree state changed.
    let mut entries: Vec<(String, u32)> = statuses
        .iter()
        .map(|s| (s.path().unwrap_or("").to_string(), s.status().bits()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::with_capacity(entries.len() * 24);
    for (path, status) in entries {
        out.push_str(&format!("{:08x} {}\n", status, path));
    }
    Ok(out)
}

pub fn compute_branch_info_sync(cwd: &str) -> Result<BranchInfo, AbundioError> {
    let repo = open_repo(cwd)?;
    let current = match repo.head() {
        Ok(h) => h.shorthand().unwrap_or("HEAD").to_string(),
        Err(_) => "HEAD".to_string(), // detached or empty repo
    };
    let default = detect_default_branch(&repo, cwd)?;
    Ok(BranchInfo {
        default_branch: default,
        current_branch: current,
    })
}

fn detect_default_branch(repo: &Repository, cwd: &str) -> Result<String, AbundioError> {
    let cache_key = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string());
    if let Some(cached) = default_branch_cache().get(&cache_key) {
        return Ok(cached.clone());
    }

    // Prefer the remote's symbolic HEAD (works for any default branch name).
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(name) = target.strip_prefix("refs/remotes/origin/") {
                if !name.is_empty() {
                    default_branch_cache().insert(cache_key, name.to_string());
                    return Ok(name.to_string());
                }
            }
        }
    }
    // Fall back to common branch names locally.
    if repo.find_reference("refs/heads/main").is_ok() {
        default_branch_cache().insert(cache_key, "main".to_string());
        return Ok("main".to_string());
    }
    if repo.find_reference("refs/heads/master").is_ok() {
        default_branch_cache().insert(cache_key, "master".to_string());
        return Ok("master".to_string());
    }
    Err(AbundioError::Git("No default branch found".to_string()))
}

fn resolve_base_branch(
    repo: &Repository,
    cwd: &str,
    base_branch: Option<String>,
) -> Result<String, AbundioError> {
    match base_branch {
        Some(b) if !b.is_empty() => Ok(b),
        _ => detect_default_branch(repo, cwd),
    }
}

pub fn compute_changed_files_sync(
    cwd: &str,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    let repo = open_repo(cwd)?;
    let base = resolve_base_branch(&repo, cwd, base_branch)?;

    let mut all_files = Vec::new();

    // 1. against_base: merge-base of HEAD..base, diffed to HEAD.
    if let Ok(files) = diff_against_base(&repo, &base) {
        all_files.extend(files);
    }

    // 2. staged: HEAD tree vs index.
    if let Ok(files) = diff_staged(&repo) {
        all_files.extend(files);
    }

    // 3. unstaged: index vs working tree.
    if let Ok(files) = diff_unstaged(&repo) {
        all_files.extend(files);
    }

    // 4. untracked: from statuses (WT_NEW flag).
    all_files.extend(untracked_files(&repo));

    Ok(all_files)
}

fn resolve_base_oid(
    repo: &Repository,
    base: &str,
) -> Result<git2::Oid, AbundioError> {
    repo.refname_to_id(&format!("refs/heads/{}", base))
        .or_else(|_| repo.refname_to_id(&format!("refs/remotes/origin/{}", base)))
        .map_err(|e| AbundioError::Git(format!("resolve base ref: {e}")))
}

fn diff_against_base(
    repo: &Repository,
    base: &str,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    let head = repo
        .head()
        .map_err(|e| AbundioError::Git(format!("head: {e}")))?
        .peel_to_commit()
        .map_err(|e| AbundioError::Git(format!("head commit: {e}")))?;

    let base_oid = resolve_base_oid(repo, base)?;
    let merge_base = repo
        .merge_base(head.id(), base_oid)
        .map_err(|e| AbundioError::Git(format!("merge base: {e}")))?;

    let merge_base_tree = repo
        .find_commit(merge_base)
        .and_then(|c| c.tree())
        .map_err(|e| AbundioError::Git(format!("merge base tree: {e}")))?;
    let head_tree = head
        .tree()
        .map_err(|e| AbundioError::Git(format!("head tree: {e}")))?;

    let mut opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&merge_base_tree), Some(&head_tree), Some(&mut opts))
        .map_err(|e| AbundioError::Git(format!("diff tree to tree: {e}")))?;
    diff_to_changed_files(&diff, "against_base")
}

fn diff_staged(repo: &Repository) -> Result<Vec<GitChangedFile>, AbundioError> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| AbundioError::Git(format!("diff tree to index: {e}")))?;
    diff_to_changed_files(&diff, "staged")
}

fn diff_unstaged(repo: &Repository) -> Result<Vec<GitChangedFile>, AbundioError> {
    let mut opts = DiffOptions::new();
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| AbundioError::Git(format!("diff index to workdir: {e}")))?;
    diff_to_changed_files(&diff, "unstaged")
}

fn diff_to_changed_files(
    diff: &Diff,
    section: &str,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    // Build file list from deltas first, then attach per-file line stats
    // via patch iteration. Two passes keeps the code simple and matches
    // the structure of the previous `git diff --name-status` + `--numstat`
    // pair the subprocess version used.
    let mut by_path: HashMap<String, GitChangedFile> = HashMap::new();

    let count = diff.deltas().count();
    for i in 0..count {
        let delta = match diff.get_delta(i) {
            Some(d) => d,
            None => continue,
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .and_then(|p| p.to_str())
            .map(String::from)
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let status = delta_status_char(delta.status());

        let (additions, deletions) = match git2::Patch::from_diff(diff, i) {
            Ok(Some(patch)) => match patch.line_stats() {
                Ok((_ctx, adds, dels)) => (adds as i32, dels as i32),
                Err(_) => (0, 0),
            },
            _ => (0, 0),
        };

        by_path.insert(
            path.clone(),
            GitChangedFile {
                path,
                status,
                additions,
                deletions,
                section: section.to_string(),
            },
        );
    }

    Ok(by_path.into_values().collect())
}

fn delta_status_char(status: Delta) -> String {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Modified => "M",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        Delta::Unmodified => " ",
        Delta::Ignored => "!",
        Delta::Untracked => "?",
        Delta::Unreadable => "X",
        Delta::Conflicted => "U",
    }
    .to_string()
}

/// Read a file's contents at a specific git tree-ish (HEAD, a branch name,
/// or a tag — anything `refname_to_id` can resolve). Returns the blob as a
/// UTF-8-lossy string, matching the existing `git show <rev>:<path>` behavior
/// that `git_file_diff` relied on. Returns empty string on any error or
/// non-existent path, mirroring the old `.unwrap_or_default()` semantics.
pub fn file_blob_at_rev(cwd: &str, rev: &str, file_path: &str) -> String {
    let Ok(repo) = open_repo(cwd) else {
        return String::new();
    };
    blob_string_at_commit(&repo, rev, file_path).unwrap_or_default()
}

fn blob_string_at_commit(
    repo: &Repository,
    rev: &str,
    file_path: &str,
) -> Option<String> {
    let oid = repo
        .refname_to_id(&format!("refs/heads/{}", rev))
        .or_else(|_| repo.refname_to_id(&format!("refs/remotes/origin/{}", rev)))
        .or_else(|_| repo.revparse_single(rev).map(|o| o.id()))
        .ok()?;
    let commit = repo.find_commit(oid).ok()?;
    let tree = commit.tree().ok()?;
    let entry = tree.get_path(std::path::Path::new(file_path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

/// Read a file's contents from the git index (the staged content).
/// Equivalent to `git show :<path>`. Returns empty string on any error.
pub fn file_blob_at_index(cwd: &str, file_path: &str) -> String {
    let Ok(repo) = open_repo(cwd) else {
        return String::new();
    };
    blob_string_at_index(&repo, file_path).unwrap_or_default()
}

fn blob_string_at_index(repo: &Repository, file_path: &str) -> Option<String> {
    let index = repo.index().ok()?;
    let entry = index.get_path(std::path::Path::new(file_path), 0)?;
    let blob = repo.find_blob(entry.id).ok()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

/// Enumerate every local and remote branch with shortname formatting,
/// matching `git branch -a --format=%(refname:short)`.
pub fn list_branches(cwd: &str) -> Result<Vec<String>, AbundioError> {
    let repo = open_repo(cwd)?;
    let mut out = Vec::new();
    for kind in [git2::BranchType::Local, git2::BranchType::Remote] {
        let iter = repo
            .branches(Some(kind))
            .map_err(|e| AbundioError::Git(format!("branches: {e}")))?;
        for entry in iter.flatten() {
            let (branch, _) = entry;
            if let Ok(Some(name)) = branch.name() {
                out.push(name.to_string());
            }
        }
    }
    Ok(out)
}

/// Cheap "is this a git repo?" check. Used by `ensure_git_repo` after a
/// canonicalized-path cache miss; mirrors the original `git rev-parse
/// --git-dir` exit-status check.
pub fn is_git_repo(cwd: &str) -> bool {
    Repository::discover(cwd).is_ok()
}

/// True if any remote's fetch or push URL points to github.com. Used by
/// `gh_status` to decide whether to show the PR panel. Purely local — reads
/// the repo's configured remotes, no network.
pub fn has_github_remote(cwd: &str) -> bool {
    let Ok(repo) = open_repo(cwd) else {
        return false;
    };
    let Ok(remotes) = repo.remotes() else {
        return false;
    };
    remotes.iter().flatten().any(|name| {
        repo.find_remote(name).is_ok_and(|remote| {
            [remote.url(), remote.pushurl()]
                .into_iter()
                .flatten()
                .any(url_is_github)
        })
    })
}

fn url_is_github(url: &str) -> bool {
    url.contains("github.com/") || url.contains("github.com:")
}

/// Current branch shortname, or None if HEAD can't be resolved (detached,
/// unborn, or not a repo). Used by `compute_workspace_git_summary` to drive
/// the sidebar branch chip.
pub fn current_branch_only(cwd: &str) -> Option<String> {
    Repository::discover(cwd)
        .ok()?
        .head()
        .ok()?
        .shorthand()
        .map(String::from)
}

/// Public wrapper around the cached default-branch detection. The cache
/// itself lives in `git_commands.rs` (alongside the public commands that
/// use it); this function does the lookup against libgit2 refs without
/// touching that cache.
pub fn detect_default_branch_uncached(cwd: &str) -> Result<String, AbundioError> {
    let repo = open_repo(cwd)?;
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(name) = target.strip_prefix("refs/remotes/origin/") {
                if !name.is_empty() {
                    return Ok(name.to_string());
                }
            }
        }
    }
    if repo.find_reference("refs/heads/main").is_ok() {
        return Ok("main".to_string());
    }
    if repo.find_reference("refs/heads/master").is_ok() {
        return Ok("master".to_string());
    }
    Err(AbundioError::Git("No default branch found".to_string()))
}

fn untracked_files(repo: &Repository) -> Vec<GitChangedFile> {
    let mut opts = StatusOptions::new();
    // Don't recurse into untracked directories: a single un-gitignored tree
    // (a fresh node_modules/ or target/) would make libgit2 walk every file
    // beneath it before our MAX_UNTRACKED cap can break the loop — the cap only
    // short-circuits the user-side iteration, not libgit2's enumeration. With
    // recursion off, libgit2 surfaces the directory itself as one untracked
    // entry (git's default `git status` behaviour), matching
    // compute_status_fingerprint_sync. See PR #94 review.
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut files = Vec::new();
    for status in statuses.iter() {
        if !status.status().contains(Status::WT_NEW) {
            continue;
        }
        if files.len() >= MAX_UNTRACKED {
            break;
        }
        if let Some(path) = status.path() {
            files.push(GitChangedFile {
                path: path.to_string(),
                status: "?".to_string(),
                additions: 0,
                deletions: 0,
                section: "untracked".to_string(),
            });
        }
    }
    files
}

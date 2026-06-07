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
use std::path::{Path, PathBuf};

use dashmap::DashMap;
use git2::{
    BranchType, Delta, Diff, DiffOptions, ErrorCode, Reference, Repository, Status, StatusOptions,
    WorktreeAddOptions, WorktreePruneOptions,
};

use crate::error::AbundioError;
use crate::git_commands::{BranchInfo, GitChangedFile};
use crate::worktree_commands::WorktreeEntry;

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
    // A freshly `git init`'d repo has an unborn HEAD: no commits, so no branch
    // refs exist yet. Read HEAD's symbolic target to recover the intended
    // default branch name (e.g. `refs/heads/main` → `main`) so the bundle still
    // resolves and the repo is recognized the moment it's initialized. Not
    // cached — the eventual default may differ once commits/remotes appear.
    if let Ok(head_ref) = repo.find_reference("HEAD") {
        if let Some(target) = head_ref.symbolic_target() {
            if let Some(name) = target.strip_prefix("refs/heads/") {
                if !name.is_empty() {
                    return Ok(name.to_string());
                }
            }
        }
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

// ── Worktrees ──
//
// git2 0.19 does NOT bind `git_repository_commondir`, so the key shared by
// all worktrees of one repository is derived from `repo.path()`:
//   - main worktree:   path() = <main>/.git                    → key = <main>/.git
//   - linked worktree: path() = <main>/.git/worktrees/<name>   → strip 2 = <main>/.git
// This relies on git's standard on-disk worktree layout. See ADR-0017.

fn canonicalize_lossy(p: &Path) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// The common git dir shared by every worktree of a repository, derived from
/// the opened repo's gitdir. `None` only if the path has no parents.
fn common_git_dir(repo: &Repository) -> Option<PathBuf> {
    let gitdir = repo.path();
    if repo.is_worktree() {
        // Prefer git's authoritative `commondir` pointer file — it handles
        // `--separate-git-dir`, submodules, and other non-standard layouts that
        // the `worktrees/<name>` strip below would group wrong. The file holds a
        // path (usually relative to the gitdir) to the common dir.
        if let Ok(contents) = std::fs::read_to_string(gitdir.join("commondir")) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                let p = Path::new(trimmed);
                return Some(if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    gitdir.join(p)
                });
            }
        }
        // Fallback for the standard layout: strip the trailing `worktrees/<name>`.
        gitdir.parent()?.parent().map(|p| p.to_path_buf())
    } else {
        Some(gitdir.to_path_buf())
    }
}

/// The facts the sidebar needs to group worktrees: a stable per-repository key,
/// whether this folder is the repository's main (primary) worktree, and the
/// worktree's *canonical* root. The canonical root lets the live-sync reconciler
/// compare a workspace against `list_repo_worktrees` output (also canonical)
/// without a symlink mismatch silently deleting it. See ADR-0017.
pub struct WorktreeSummaryBits {
    pub group_key: Option<String>,
    pub is_main_worktree: bool,
    pub canonical_root: Option<String>,
}

pub fn worktree_summary_bits(cwd: &str) -> WorktreeSummaryBits {
    match Repository::discover(cwd) {
        Ok(repo) => WorktreeSummaryBits {
            group_key: common_git_dir(&repo).map(|p| canonicalize_lossy(&p)),
            is_main_worktree: !repo.is_worktree()
                && !repo.is_bare()
                && repo.workdir().is_some(),
            canonical_root: repo.workdir().map(canonicalize_lossy),
        },
        Err(_) => WorktreeSummaryBits {
            group_key: None,
            is_main_worktree: false,
            canonical_root: None,
        },
    }
}

fn head_shorthand(cwd: &Path) -> Option<String> {
    Repository::discover(cwd)
        .ok()?
        .head()
        .ok()?
        .shorthand()
        .map(String::from)
}

/// Open the MAIN repository from any worktree's cwd (so `worktrees()` and
/// `workdir()` reflect the whole repo, not just the linked tree we're in).
fn open_main_repo(cwd: &str) -> Result<Repository, AbundioError> {
    let repo = open_repo(cwd)?;
    let common = common_git_dir(&repo)
        .ok_or_else(|| AbundioError::Git("cannot resolve common git dir".into()))?;
    Repository::open(&common).map_err(|e| AbundioError::Git(format!("open main repo: {e}")))
}

/// Enumerate all worktrees of the repository `cwd` belongs to: the main
/// worktree (unless bare) first as primary, then every linked worktree whose
/// folder still exists on disk. Each entry carries its checked-out branch.
pub fn list_repo_worktrees(cwd: &str) -> Result<Vec<WorktreeEntry>, AbundioError> {
    let main_repo = open_main_repo(cwd)?;
    let mut entries = Vec::new();

    if let Some(workdir) = main_repo.workdir() {
        entries.push(WorktreeEntry {
            path: canonicalize_lossy(workdir),
            branch: head_shorthand(workdir),
            is_primary: true,
            exists: workdir.exists(),
        });
    }

    if let Ok(names) = main_repo.worktrees() {
        for name in names.iter().flatten() {
            let Ok(wt) = main_repo.find_worktree(name) else {
                continue;
            };
            let wt_path = wt.path();
            // Include git-tracked worktrees even when their folder is gone (the
            // frontend uses `exists` to tell stale-folder from real removal).
            let exists = wt_path.exists();
            entries.push(WorktreeEntry {
                path: canonicalize_lossy(wt_path),
                branch: if exists { head_shorthand(wt_path) } else { None },
                is_primary: false,
                exists,
            });
        }
    }

    Ok(entries)
}

/// Sanitize a folder path into a git worktree admin name (basename, unique key
/// in `.git/worktrees/`). Falls back to "worktree" if no basename.
fn worktree_name_for(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "worktree".to_string())
}

/// Resolve the branch the new worktree should check out, creating it when
/// needed. Returns the reference plus whether we created a branch (so the
/// caller can roll it back if the worktree add then fails).
fn resolve_worktree_branch<'r>(
    main_repo: &'r Repository,
    branch: &str,
) -> Result<(Reference<'r>, bool), AbundioError> {
    if let Ok(b) = main_repo.find_branch(branch, BranchType::Local) {
        // Existing local branch — git refuses to check it out if it's already
        // checked out in another worktree, surfaced as the add error.
        return Ok((
            b.into_reference(),
            false,
        ));
    }
    if let Ok(remote_b) = main_repo.find_branch(&format!("origin/{branch}"), BranchType::Remote) {
        // Exists only on the remote — create a local tracking branch.
        let commit = remote_b
            .get()
            .peel_to_commit()
            .map_err(|e| AbundioError::Git(format!("peel origin/{branch}: {e}")))?;
        let mut local = main_repo
            .branch(branch, &commit, false)
            .map_err(|e| AbundioError::Git(format!("create tracking branch: {e}")))?;
        let _ = local.set_upstream(Some(&format!("origin/{branch}")));
        return Ok((local.into_reference(), true));
    }
    // New branch forked from the primary worktree's current HEAD. A repo with
    // no commits (unborn HEAD, e.g. right after `git init`) has no commit to
    // base a worktree on — git itself can't do this — so surface a clear,
    // actionable message instead of the raw libgit2 "reference not found".
    let head = main_repo.head().map_err(|e| {
        if e.code() == ErrorCode::UnbornBranch {
            AbundioError::Git(
                "this repository has no commits yet — make an initial commit before adding a worktree"
                    .to_string(),
            )
        } else {
            AbundioError::Git(format!("primary HEAD: {e}"))
        }
    })?;
    let head_commit = head
        .peel_to_commit()
        .map_err(|e| AbundioError::Git(format!("primary HEAD commit: {e}")))?;
    let b = main_repo
        .branch(branch, &head_commit, false)
        .map_err(|e| AbundioError::Git(format!("create branch '{branch}': {e}")))?;
    Ok((b.into_reference(), true))
}

/// Create a new worktree of the repository at `path`, checking out `branch`
/// (created from the primary's HEAD when it doesn't exist). `path` must be an
/// absolute, non-existent folder; its parent is created if missing.
pub fn add_worktree(
    primary_cwd: &str,
    branch: &str,
    path: &str,
) -> Result<WorktreeEntry, AbundioError> {
    let main_repo = open_main_repo(primary_cwd)?;

    let target = Path::new(path);
    if target.exists() {
        return Err(AbundioError::Git(format!(
            "target folder already exists: {path}"
        )));
    }

    // Resolve the branch before touching the filesystem so a failure here (e.g.
    // a commitless repo's unborn HEAD) doesn't leave an empty `.worktrees` dir
    // behind.
    let (branch_ref, created_branch) = resolve_worktree_branch(&main_repo, branch)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(AbundioError::Io)?;
    }

    let name = worktree_name_for(target);
    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&branch_ref));

    if let Err(e) = main_repo.worktree(&name, target, Some(&opts)) {
        // Roll back a branch we created so a retry isn't blocked by it.
        if created_branch {
            if let Ok(mut b) = main_repo.find_branch(branch, BranchType::Local) {
                let _ = b.delete();
            }
        }
        // Best-effort: remove the parent dir we may have created above.
        // `remove_dir` only succeeds when empty, so a pre-existing populated
        // `<repo>.worktrees/` (other worktrees) is left untouched.
        if let Some(parent) = target.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        return Err(AbundioError::Git(format!("worktree add: {e}")));
    }

    Ok(WorktreeEntry {
        path: canonicalize_lossy(target),
        branch: Some(branch.to_string()),
        is_primary: false,
        exists: true,
    })
}

/// Remove the worktree whose folder is `worktree_path`: deletes the folder and
/// prunes git's admin link. The branch is left intact. Errors (without forcing)
/// if the worktree is locked.
pub fn remove_worktree(primary_cwd: &str, worktree_path: &str) -> Result<(), AbundioError> {
    let main_repo = open_main_repo(primary_cwd)?;
    let target = canonicalize_lossy(Path::new(worktree_path));

    let names = main_repo
        .worktrees()
        .map_err(|e| AbundioError::Git(format!("worktrees: {e}")))?;
    for name in names.iter().flatten() {
        let Ok(wt) = main_repo.find_worktree(name) else {
            continue;
        };
        if canonicalize_lossy(wt.path()) == target {
            let mut opts = WorktreePruneOptions::new();
            // valid: prune even though the worktree still exists.
            // working_tree: actually delete the folder on disk.
            // locked stays false → a locked worktree errors instead of force-prune.
            opts.valid(true).working_tree(true);
            wt.prune(Some(&mut opts))
                .map_err(|e| AbundioError::Git(format!("prune worktree: {e}")))?;
            return Ok(());
        }
    }
    Err(AbundioError::NotFound(format!(
        "worktree not found: {worktree_path}"
    )))
}

/// True if the worktree at `cwd` has any staged or unstaged change, or an
/// untracked file — used to escalate the Remove-worktree confirmation.
pub fn worktree_is_dirty(cwd: &str) -> bool {
    let Ok(repo) = open_repo(cwd) else {
        return false;
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let dirty = match repo.statuses(Some(&mut opts)) {
        Ok(statuses) => statuses.iter().any(|s| {
            s.status().intersects(
                Status::WT_NEW
                    | Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE
                    | Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE
                    | Status::CONFLICTED,
            )
        }),
        Err(_) => false,
    };
    dirty
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_repo_resolves_default_branch_from_unborn_head() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        // A bare `init` leaves an unborn HEAD: no commits, no branch refs yet.
        git2::Repository::init(dir.path()).unwrap();

        // Branch info must still resolve (no "No default branch found"), so the
        // GitScheduler can emit a success bundle the moment `git init` runs and
        // the repo gets recognized instead of staying "Not a git repository".
        let info = compute_branch_info_sync(path).expect("branch info for fresh repo");
        assert!(!info.default_branch.is_empty());
        // Changed-files must not error on the unborn repo either.
        let files =
            compute_changed_files_sync(path, None).expect("changed files for fresh repo");
        assert!(files.is_empty());
        // And it must register as a (main) git worktree for sidebar grouping.
        let bits = worktree_summary_bits(path);
        assert!(bits.group_key.is_some());
        assert!(bits.is_main_worktree);
    }

    #[test]
    fn non_repo_dir_is_not_a_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert!(!is_git_repo(path));
        assert!(compute_branch_info_sync(path).is_err());
        let bits = worktree_summary_bits(path);
        assert!(bits.group_key.is_none());
        assert!(!bits.is_main_worktree);
    }
}

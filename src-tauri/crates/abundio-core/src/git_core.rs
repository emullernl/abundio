//! Git facts for a Workspace with no Tauri: changed files, branch info,
//! history, conflicts, the status fingerprint and the sidebar summary. The
//! `git_*` commands (`git_commands.rs`) and the git scheduler call into it.

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
pub fn default_branch_cache() -> &'static DashMap<String, String> {
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

/// One commit in the **Commits** section (see GLOSSARY.md).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub oid: String,
    pub subject: String,
    /// The full message, subject included — for the row's tooltip.
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch.
    pub time: i64,
    pub is_merge: bool,
    /// Below the divider: **Shared history**, which the base branch also has.
    /// False for an **Ahead commit**, and for every row when the base is
    /// unknown (there is no divider then).
    pub shared: bool,
    /// Reachable from a tracking ref of the GitHub remote named by
    /// `CommitHistory::github_slug`. Gates "Open on GitHub": a commit that
    /// remote does not have has no page there.
    pub on_remote: bool,
}

/// The **Commits** section's list: the Workspace's recent history, newest
/// first, capped at `COMMIT_HISTORY_CAP` rows. First every **Ahead commit**
/// (`base..HEAD`), then the **Shared history** from where the branch last met
/// its base — so the two halves never interleave. See GLOSSARY.md.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistory {
    /// The base branch the divider is named after. `None` when it cannot be
    /// resolved; the list is then plain HEAD history with no divider.
    pub base: Option<String>,
    /// The true number of Ahead commits, even past the row cap. 0 when the
    /// base is unknown.
    pub ahead: usize,
    pub commits: Vec<HistoryCommit>,
    /// `owner/repo` of the GitHub remote "Open on GitHub" links to, chosen
    /// alongside `on_remote` so the two describe the same repository.
    pub github_slug: Option<String>,
}

/// One file a single commit touched, measured against its first parent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub status: String,
    pub additions: i32,
    pub deletions: i32,
    /// Git's own binary test on the blob. Such a row is shown but not
    /// clickable: a text diff of it would only be replacement characters.
    pub is_binary: bool,
    /// A submodule pointer (a commit in another repository), not a file.
    /// Shown but not clickable: it has no text on either side to diff.
    pub is_submodule: bool,
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

pub fn cache_key_for(cwd: &str) -> String {
    std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string())
}

pub fn detect_default_branch(cwd: &str) -> Result<String, AbundioError> {
    let key = cache_key_for(cwd);
    if let Some(cached) = default_branch_cache().get(&key) {
        return Ok(cached.clone());
    }
    let detected = git_libgit2::detect_default_branch_uncached(cwd)?;
    default_branch_cache().insert(key, detected.clone());
    Ok(detected)
}

pub fn resolve_base_branch(cwd: &str, base_branch: Option<String>) -> Result<String, AbundioError> {
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

pub fn compute_changed_files_sync(
    cwd: &str,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    crate::git_libgit2::compute_changed_files_sync(cwd, base_branch)
}

pub fn compute_branch_info_sync(cwd: &str) -> Result<BranchInfo, AbundioError> {
    crate::git_libgit2::compute_branch_info_sync(cwd)
}

pub fn compute_status_fingerprint_sync(cwd: &str) -> Result<String, AbundioError> {
    crate::git_libgit2::compute_status_fingerprint_sync(cwd)
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
    /// `None` when the base branch cannot be resolved to a commit. Best-effort
    /// like `operation_in_progress`: it never fails the bundle.
    pub commit_history: Option<CommitHistory>,
}

/// Reject anything that isn't a plain repository-relative path.
///
/// Shared by every command that turns a caller-supplied path into a filesystem
/// or index lookup. `git_stage_path` *writes* through this, so it must not grow
/// its own copy — one validator, one set of rules.
pub fn validate_repo_relative(file_path: &str) -> Result<(), AbundioError> {
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
    /// True when the working tree holds uncommitted work (untracked, unstaged,
    /// staged or conflicted) — a **Dirty workspace**. Commits ahead of the base
    /// branch do not count. Always false for a non-repo.
    pub is_dirty: bool,
}

/// Resolves the per-workspace git facts via libgit2: current branch, worktree
/// grouping bits, GitHub repo identity, and whether the working tree is dirty.
/// All of them run against **one** open repository — the `_in` variants exist so
/// this batch, which runs across the whole Profile on every workspace-list
/// change, pays for a single `Repository::discover` per workspace rather than
/// one each.
///
/// The first three are config/HEAD reads and cost almost nothing. `is_dirty` is
/// **not**: it is a full `repo.statuses()` walk, proportional to the number of
/// non-ignored files in the worktree. That is why the caller runs the requests
/// concurrently rather than in one serial pass, and why the frontend asks only
/// about workspaces whose dirtiness isn't already live (see
/// `uncommittedFromSummaries`).
///
/// Change *stats* remain excluded — they're computed by `git_changed_files`
/// whenever a workspace's scheduler runs, and synced back to the workspace chip
/// store via the frontend.
pub fn compute_workspace_git_summary(req: WorkspaceGitRequest) -> WorkspaceGitSummary {
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
    let is_dirty = is_git_repo && repo.as_ref().is_some_and(git_libgit2::worktree_is_dirty_in);
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
        is_dirty,
    }
}

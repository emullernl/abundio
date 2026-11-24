//! **Incoming** and **Outgoing commits** against a Workspace's **Upstream**,
//! and the two network operations behind them: fetch and **Pull** (ADR-0066).
//!
//! Reading the counts is libgit2, like every other git read, and runs on each
//! scheduler refresh. Fetch and Pull run the `git` CLI instead: they are rare,
//! wait on the network, and the CLI uses the user's own ssh agent, credential
//! helpers and hooks, which libgit2 does not. Both run with every prompt off,
//! so a remote that wants a password fails at once instead of hanging.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use git2::{BranchType, Oid, Repository, StatusOptions};
use serde::Serialize;

use crate::error::AbundioError;
use crate::git_core::HistoryCommit;

/// At most this many Incoming commits are listed; the count is always true.
pub const INCOMING_LIST_CAP: usize = 50;
/// How long a successful fetch is reused by the next caller for the same
/// repository and remote, so a Worktree set is fetched once, and a Pull right
/// after a check does not fetch twice. A failure is never reused: the next
/// try may be the one after the user unlocked their ssh agent.
const FETCH_REUSE: Duration = Duration::from_secs(10);
/// A fetch that takes longer than this is killed. Generous: a first fetch of
/// a busy remote over a slow link takes minutes.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// The fast-forward itself is local, but a `post-merge` hook (an install
/// step) runs inside it.
const MERGE_TIMEOUT: Duration = Duration::from_secs(2 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamState {
    /// Short name, e.g. `origin/feature-x`.
    pub name: String,
    /// The remote it lives on, e.g. `origin`.
    pub remote: String,
    pub incoming: usize,
    pub outgoing: usize,
    /// Newest first, at most `INCOMING_LIST_CAP`.
    pub incoming_commits: Vec<HistoryCommit>,
    /// When the repository last fetched (FETCH_HEAD's time), from Abundio or a
    /// terminal alike; seconds since the Unix epoch. `None` if never.
    pub last_fetched: Option<i64>,
}

// ───────────────────────── Reading ─────────────────────────

fn open(cwd: &str) -> Result<Repository, AbundioError> {
    Repository::discover(cwd).map_err(|e| match e.code() {
        git2::ErrorCode::NotFound => AbundioError::NotGitRepo(cwd.to_string()),
        _ => AbundioError::Git(format!("open repo: {e}")),
    })
}

/// The current branch's Upstream: (local branch name, upstream short name,
/// remote name, upstream tip). `None` for a detached HEAD, an unborn branch or
/// a branch that tracks nothing (or whose upstream ref is gone).
fn upstream_of(repo: &Repository) -> Option<(String, String, String, Oid)> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let local_name = head.shorthand()?.to_string();
    let local = repo.find_branch(&local_name, BranchType::Local).ok()?;
    let upstream = local.upstream().ok()?;
    let short = upstream.name().ok()??.to_string();
    let tip = upstream.get().target()?;
    let full = upstream.get().name()?.to_string();
    let remote = repo
        .branch_remote_name(&full)
        .ok()
        .and_then(|b| b.as_str().map(String::from))?;
    Some((local_name, short, remote, tip))
}

fn last_fetched(repo: &Repository) -> Option<i64> {
    let meta = std::fs::metadata(repo.commondir().join("FETCH_HEAD")).ok()?;
    let t = meta.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64)
}

type UpstreamCache = DashMap<String, (String, UpstreamState)>;
fn cache() -> &'static UpstreamCache {
    static C: OnceLock<UpstreamCache> = OnceLock::new();
    C.get_or_init(DashMap::new)
}

/// The Workspace's Upstream with its Incoming and Outgoing counts, or `None`
/// when there is no Upstream. Cached on (HEAD, Upstream tip), because the
/// scheduler calls this on every file change.
pub fn compute_upstream_sync(cwd: &str) -> Result<Option<UpstreamState>, AbundioError> {
    let repo = open(cwd)?;
    let Some((_, name, remote, tip)) = upstream_of(&repo) else {
        return Ok(None);
    };
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .ok_or_else(|| AbundioError::Git("HEAD has no commit".into()))?;
    let fetched = last_fetched(&repo);
    let key = format!("{head}\n{tip}\n{name}");
    let slot = repo.path().to_string_lossy().to_string();
    if let Some(hit) = cache().get(&slot) {
        if hit.0 == key {
            let mut s = hit.1.clone();
            s.last_fetched = fetched;
            return Ok(Some(s));
        }
    }
    let (outgoing, incoming) = repo
        .graph_ahead_behind(head, tip)
        .map_err(|e| AbundioError::Git(format!("ahead/behind: {e}")))?;
    let incoming_commits = if incoming == 0 {
        Vec::new()
    } else {
        list_range(&repo, tip, head, INCOMING_LIST_CAP)?
    };
    let state = UpstreamState {
        name,
        remote,
        incoming,
        outgoing,
        incoming_commits,
        last_fetched: fetched,
    };
    cache().insert(slot, (key, state.clone()));
    Ok(Some(state))
}

/// Commits reachable from `from` but not `hide`, newest first, at most `cap`.
fn list_range(
    repo: &Repository,
    from: Oid,
    hide: Oid,
    cap: usize,
) -> Result<Vec<HistoryCommit>, AbundioError> {
    let err = |e: git2::Error| AbundioError::Git(format!("revwalk: {e}"));
    let mut walk = repo.revwalk().map_err(err)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(err)?;
    walk.push(from).map_err(err)?;
    walk.hide(hide).map_err(err)?;
    Ok(walk
        .flatten()
        .take(cap)
        .filter_map(|oid| repo.find_commit(oid).ok())
        .map(|c| {
            let author = c.author();
            HistoryCommit {
                oid: c.id().to_string(),
                subject: c.summary().unwrap_or("").to_string(),
                message: c.message().unwrap_or("").trim_end().to_string(),
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                time: author.when().seconds(),
                is_merge: c.parent_count() > 1,
                shared: false,
                // It is on the Upstream's remote by definition.
                on_remote: true,
            }
        })
        .collect())
}

// ───────────────────────── Running git ─────────────────────────

/// `git` with every way to ask the user for something turned off. A GUI app
/// has no terminal, so a prompt would either fail or hang until the timeout.
fn quiet_git(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        // Nothing reads stdout; a hook may print a lot to it.
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        // English messages: Pull's refusal parsing reads git's stderr.
        .env("LC_ALL", "C");
    // Respect a user's own ssh command; otherwise make ssh fail instead of
    // asking for a passphrase or a host key confirmation.
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        let configured = Repository::discover(cwd)
            .ok()
            .and_then(|r| r.config().ok())
            .and_then(|c| c.get_string("core.sshCommand").ok());
        if configured.is_none() {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
    }
    cmd
}

/// Run to completion or kill at `timeout`. Ok(stderr) on success,
/// Err(message) otherwise. stderr is drained on its own thread while this one
/// watches the clock: a hook that prints more than the pipe holds would
/// otherwise block git on its write until the timeout killed it.
fn run(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git not found".to_string()
        } else {
            format!("could not run git: {e}")
        }
    })?;
    let reader = child.stderr.take().map(|mut e| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = e.read_to_end(&mut buf);
            buf
        })
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git timed out after {} min",
                    timeout.as_secs().div_ceil(60)
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("git: {e}")),
        }
    };
    let stderr = reader
        .and_then(|h| h.join().ok())
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .unwrap_or_default();
    if status.success() {
        Ok(stderr)
    } else if stderr.is_empty() {
        Err(format!("git exited with {status}"))
    } else {
        Err(stderr)
    }
}

// ───────────────────────── Fetch ─────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FetchOutcome {
    /// Fetched. `common_dir` names the repository, so the caller can refresh
    /// every Workspace that shares it.
    Fetched {
        #[serde(skip)]
        common_dir: PathBuf,
    },
    /// No Upstream to fetch: detached HEAD, or a branch that tracks nothing.
    NoUpstream,
    /// A background check of a repository nobody has fetched in yet: left
    /// alone until the user checks or pulls by hand (ADR-0066).
    Skipped,
    Failed {
        message: String,
    },
}

type FetchSlot = Arc<Mutex<Option<(Instant, FetchOutcome)>>>;
fn fetch_slots() -> &'static DashMap<String, FetchSlot> {
    static S: OnceLock<DashMap<String, FetchSlot>> = OnceLock::new();
    S.get_or_init(DashMap::new)
}

/// Fetch the remote the current branch's Upstream lives on. One fetch at a
/// time per (repository, remote); a caller within `FETCH_REUSE` of the last
/// successful one gets its result instead of fetching again.
///
/// `background` is a fetch nobody asked for (the timer, window focus). It runs
/// only in a repository that has fetched before (it has a FETCH_HEAD), so a
/// folder from an untrusted source does not get its `.git/config` acted on
/// just by being opened as a Workspace. Every fetch also turns hooks and
/// fsmonitor off, which a fetch has no use for.
pub fn fetch_upstream(cwd: &str, background: bool) -> Result<FetchOutcome, AbundioError> {
    let repo = open(cwd)?;
    let Some((_, _, remote, _)) = upstream_of(&repo) else {
        return Ok(FetchOutcome::NoUpstream);
    };
    if background && last_fetched(&repo).is_none() {
        return Ok(FetchOutcome::Skipped);
    }
    let common = std::fs::canonicalize(repo.commondir()).unwrap_or(repo.commondir().into());
    drop(repo);
    let key = format!("{}\n{remote}", common.display());
    let slot = fetch_slots().entry(key).or_default().clone();
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, outcome)) = guard.as_ref() {
        if at.elapsed() < FETCH_REUSE {
            return Ok(outcome.clone());
        }
    }
    // Git writes FETCH_HEAD, which is what `last_fetched` reads, as it does
    // for a fetch typed in a terminal. `--` so a remote name can never be
    // read as an option.
    let mut cmd = quiet_git(Path::new(cwd));
    cmd.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "fetch",
        "--quiet",
        "--",
        &remote,
    ]);
    let outcome = match run(cmd, FETCH_TIMEOUT) {
        Ok(_) => FetchOutcome::Fetched { common_dir: common },
        Err(message) => FetchOutcome::Failed { message },
    };
    *guard = match outcome {
        FetchOutcome::Fetched { .. } => Some((Instant::now(), outcome.clone())),
        _ => None,
    };
    Ok(outcome)
}

// ───────────────────────── Pull ─────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RefusedReason {
    NoUpstream,
    Detached,
    /// A merge, rebase, cherry-pick or revert is in progress.
    Operation,
    Diverged,
    /// Incoming changes touch paths with uncommitted work (`files`).
    Overlap,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PullOutcome {
    Pulled {
        count: usize,
        upstream: String,
    },
    UpToDate {
        upstream: String,
    },
    Refused {
        reason: RefusedReason,
        /// Repo-relative paths, for `Overlap`; empty otherwise.
        files: Vec<String>,
        upstream: Option<String>,
        outgoing: usize,
        incoming: usize,
    },
    FetchFailed {
        message: String,
    },
    Failed {
        message: String,
    },
}

/// Paths with uncommitted work: staged, unstaged or untracked (not ignored).
fn uncommitted_paths(repo: &Repository) -> Result<HashSet<String>, AbundioError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AbundioError::Git(format!("status: {e}")))?;
    Ok(statuses
        .iter()
        .filter_map(|s| s.path().map(String::from))
        .collect())
}

/// Paths an incoming fast-forward from `head` to `tip` would change.
fn incoming_paths(repo: &Repository, head: Oid, tip: Oid) -> Result<HashSet<String>, AbundioError> {
    let err = |e: git2::Error| AbundioError::Git(format!("diff: {e}"));
    let a = repo.find_commit(head).and_then(|c| c.tree()).map_err(err)?;
    let b = repo.find_commit(tip).and_then(|c| c.tree()).map_err(err)?;
    let diff = repo
        .diff_tree_to_tree(Some(&a), Some(&b), None)
        .map_err(err)?;
    let mut out = HashSet::new();
    for d in diff.deltas() {
        for f in [d.old_file(), d.new_file()] {
            if let Some(p) = f.path().and_then(|p| p.to_str()) {
                out.insert(p.to_string());
            }
        }
    }
    Ok(out)
}

/// Check what stands in the way of a fast-forward, from local state only.
/// `Ok(None)` means go ahead.
fn pull_blocker(cwd: &str) -> Result<Option<PullOutcome>, AbundioError> {
    let repo = open(cwd)?;
    let detached = repo.head_detached().unwrap_or(false);
    let refuse = |reason, files, upstream: Option<String>, outgoing, incoming| {
        Ok(Some(PullOutcome::Refused {
            reason,
            files,
            upstream,
            outgoing,
            incoming,
        }))
    };
    if detached {
        return refuse(RefusedReason::Detached, vec![], None, 0, 0);
    }
    if repo.state() != git2::RepositoryState::Clean {
        return refuse(RefusedReason::Operation, vec![], None, 0, 0);
    }
    let Some((_, name, _, tip)) = upstream_of(&repo) else {
        return refuse(RefusedReason::NoUpstream, vec![], None, 0, 0);
    };
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .ok_or_else(|| AbundioError::Git("HEAD has no commit".into()))?;
    let (outgoing, incoming) = repo
        .graph_ahead_behind(head, tip)
        .map_err(|e| AbundioError::Git(format!("ahead/behind: {e}")))?;
    if incoming == 0 {
        return Ok(Some(PullOutcome::UpToDate { upstream: name }));
    }
    if outgoing > 0 {
        return refuse(
            RefusedReason::Diverged,
            vec![],
            Some(name),
            outgoing,
            incoming,
        );
    }
    let dirty = uncommitted_paths(&repo)?;
    if !dirty.is_empty() {
        let changed = incoming_paths(&repo, head, tip)?;
        // Untracked directories are listed file by file (`recurse_untracked_dirs`),
        // so an untracked file the incoming side adds is caught here too.
        let mut overlap: Vec<String> = dirty.intersection(&changed).cloned().collect();
        if !overlap.is_empty() {
            overlap.sort();
            return refuse(
                RefusedReason::Overlap,
                overlap,
                Some(name),
                outgoing,
                incoming,
            );
        }
    }
    Ok(None)
}

/// Fetch, then fast-forward the current branch to its Upstream. Never merges,
/// rebases or stashes (ADR-0066). The caller refreshes the repository's
/// Workspaces afterwards, whatever the outcome: the fetch alone may have moved
/// their counts.
pub fn pull_ff(cwd: &str) -> Result<PullOutcome, AbundioError> {
    if let FetchOutcome::Failed { message } = fetch_upstream(cwd, false)? {
        return Ok(PullOutcome::FetchFailed { message });
    }
    if let Some(blocked) = pull_blocker(cwd)? {
        return Ok(blocked);
    }
    let repo = open(cwd)?;
    let (_, name, _, tip) =
        upstream_of(&repo).ok_or_else(|| AbundioError::Git("no upstream".into()))?;
    let head = repo.head().ok().and_then(|h| h.target());
    drop(repo);
    let mut cmd = quiet_git(Path::new(cwd));
    cmd.args(["merge", "--ff-only", "--quiet", "@{u}"]);
    let result = run(cmd, MERGE_TIMEOUT);
    // The branch moving is what counts. A `post-merge` hook runs after the
    // fast-forward, so a hook that fails or runs past the timeout must not
    // turn a done Pull into a "failed" one.
    let repo = open(cwd)?;
    let now = repo.head().ok().and_then(|h| h.target());
    if result.is_ok() || (now.is_some() && now != head && now == Some(tip)) {
        let count = match (head, now) {
            (Some(a), Some(b)) => repo.graph_ahead_behind(b, a).map(|(n, _)| n).unwrap_or(0),
            _ => 0,
        };
        return Ok(PullOutcome::Pulled {
            count,
            upstream: name,
        });
    }
    match result {
        Ok(_) => unreachable!("handled above"),
        Err(message) => {
            // Our own check missed something git saw (a race with an Agent,
            // or a case like a case-only rename): report git's file list.
            let files = files_from_git_refusal(&message);
            if files.is_empty() {
                Ok(PullOutcome::Failed { message })
            } else {
                Ok(PullOutcome::Refused {
                    reason: RefusedReason::Overlap,
                    files,
                    upstream: Some(name),
                    outgoing: 0,
                    incoming: 0,
                })
            }
        }
    }
}

/// The tab-indented path lines git prints under "would be overwritten by merge".
fn files_from_git_refusal(stderr: &str) -> Vec<String> {
    if !stderr.contains("would be overwritten") {
        return Vec::new();
    }
    stderr
        .lines()
        .filter(|l| l.starts_with('\t'))
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The canonical common git directory of the repository at `cwd`, which every
/// worktree of one repository shares.
pub fn common_dir(cwd: &str) -> Option<PathBuf> {
    let repo = Repository::discover(cwd).ok()?;
    Some(std::fs::canonicalize(repo.commondir()).unwrap_or(repo.commondir().into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git failed to spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn configure(p: &Path) {
        git(p, &["config", "user.email", "t@t.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "commit.gpgsign", "false"]);
    }

    fn commit(p: &Path, file: &str, text: &str) {
        std::fs::write(p.join(file), text).unwrap();
        git(p, &["add", file]);
        git(p, &["commit", "-qm", &format!("edit {file}")]);
    }

    /// A bare remote, a clone of it (`mine`, the Workspace) and another clone
    /// (`theirs`) that pushes the incoming commits.
    struct World {
        _dir: tempfile::TempDir,
        mine: PathBuf,
        theirs: PathBuf,
    }

    fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let remote = root.join("remote.git");
        git(
            root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        let seed = root.join("seed");
        git(root, &["init", "-q", "-b", "main", seed.to_str().unwrap()]);
        configure(&seed);
        commit(&seed, "a.txt", "a\n");
        commit(&seed, "b.txt", "b\n");
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["push", "-q", "-u", "origin", "main"]);
        let mine = root.join("mine");
        let theirs = root.join("theirs");
        for c in [&mine, &theirs] {
            git(
                root,
                &["clone", "-q", remote.to_str().unwrap(), c.to_str().unwrap()],
            );
            configure(c);
        }
        World {
            _dir: dir,
            mine,
            theirs,
        }
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn push_from_theirs(w: &World, file: &str, text: &str) {
        commit(&w.theirs, file, text);
        git(&w.theirs, &["push", "-q"]);
    }

    fn state(p: &Path) -> UpstreamState {
        compute_upstream_sync(s(p)).unwrap().expect("has upstream")
    }

    fn pull(p: &Path) -> PullOutcome {
        // Each test's repo is fresh, so the fetch reuse never crosses tests.
        pull_ff(s(p)).unwrap()
    }

    #[test]
    fn a_fresh_clone_is_level_with_its_upstream() {
        let w = world();
        let st = state(&w.mine);
        assert_eq!(st.name, "origin/main");
        assert_eq!(st.remote, "origin");
        assert_eq!((st.incoming, st.outgoing), (0, 0));
    }

    #[test]
    fn no_upstream_for_a_local_branch_or_detached_head() {
        let w = world();
        git(&w.mine, &["checkout", "-q", "-b", "local-only"]);
        assert_eq!(compute_upstream_sync(s(&w.mine)).unwrap(), None);
        git(&w.mine, &["checkout", "-q", "--detach"]);
        assert_eq!(compute_upstream_sync(s(&w.mine)).unwrap(), None);
        assert_eq!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::NoUpstream
        );
    }

    #[test]
    fn incoming_appears_only_after_a_fetch() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        push_from_theirs(&w, "c.txt", "c\n");
        assert_eq!(state(&w.mine).incoming, 0);
        assert!(matches!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::Fetched { .. }
        ));
        let st = state(&w.mine);
        assert_eq!((st.incoming, st.outgoing), (2, 0));
        assert_eq!(st.incoming_commits.len(), 2);
        assert_eq!(st.incoming_commits[0].subject, "edit c.txt");
        assert!(st.last_fetched.is_some());
    }

    #[test]
    fn outgoing_counts_local_commits() {
        let w = world();
        commit(&w.mine, "a.txt", "mine\n");
        let st = state(&w.mine);
        assert_eq!((st.incoming, st.outgoing), (0, 1));
    }

    #[test]
    fn pull_fast_forwards() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        push_from_theirs(&w, "c.txt", "c\n");
        assert_eq!(
            pull(&w.mine),
            PullOutcome::Pulled {
                count: 2,
                upstream: "origin/main".into()
            }
        );
        assert_eq!(
            std::fs::read_to_string(w.mine.join("c.txt")).unwrap(),
            "c\n"
        );
        assert_eq!(state(&w.mine).incoming, 0);
    }

    #[test]
    fn pull_when_level_says_up_to_date() {
        let w = world();
        assert_eq!(
            pull(&w.mine),
            PullOutcome::UpToDate {
                upstream: "origin/main".into()
            }
        );
    }

    #[test]
    fn pull_keeps_uncommitted_work_in_other_files() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        std::fs::write(w.mine.join("b.txt"), "my edit\n").unwrap();
        std::fs::write(w.mine.join("new.txt"), "untracked\n").unwrap();
        assert!(matches!(
            pull(&w.mine),
            PullOutcome::Pulled { count: 1, .. }
        ));
        assert_eq!(
            std::fs::read_to_string(w.mine.join("b.txt")).unwrap(),
            "my edit\n"
        );
        assert_eq!(
            std::fs::read_to_string(w.mine.join("a.txt")).unwrap(),
            "a2\n"
        );
        assert!(w.mine.join("new.txt").exists());
    }

    #[test]
    fn pull_refuses_when_incoming_touches_an_edited_file() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        std::fs::write(w.mine.join("a.txt"), "my edit\n").unwrap();
        match pull(&w.mine) {
            PullOutcome::Refused { reason, files, .. } => {
                assert_eq!(reason, RefusedReason::Overlap);
                assert_eq!(files, vec!["a.txt".to_string()]);
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(w.mine.join("a.txt")).unwrap(),
            "my edit\n"
        );
    }

    #[test]
    fn pull_refuses_when_incoming_adds_a_file_that_exists_untracked() {
        let w = world();
        push_from_theirs(&w, "c.txt", "theirs\n");
        std::fs::write(w.mine.join("c.txt"), "mine\n").unwrap();
        match pull(&w.mine) {
            PullOutcome::Refused { reason, files, .. } => {
                assert_eq!(reason, RefusedReason::Overlap);
                assert_eq!(files, vec!["c.txt".to_string()]);
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn pull_refuses_a_diverged_branch() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        commit(&w.mine, "b.txt", "mine\n");
        match pull(&w.mine) {
            PullOutcome::Refused {
                reason,
                outgoing,
                incoming,
                ..
            } => {
                assert_eq!(reason, RefusedReason::Diverged);
                assert_eq!((outgoing, incoming), (1, 1));
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn pull_refuses_mid_merge() {
        let w = world();
        push_from_theirs(&w, "a.txt", "a2\n");
        git(&w.mine, &["checkout", "-q", "-b", "side"]);
        commit(&w.mine, "a.txt", "side\n");
        git(&w.mine, &["checkout", "-q", "main"]);
        commit(&w.mine, "a.txt", "main\n");
        let _ = Command::new("git")
            .args(["merge", "side"])
            .current_dir(&w.mine)
            .output();
        assert!(matches!(
            pull(&w.mine),
            PullOutcome::Refused {
                reason: RefusedReason::Operation,
                ..
            }
        ));
    }

    #[test]
    fn pull_refuses_a_detached_head() {
        let w = world();
        git(&w.mine, &["checkout", "-q", "--detach"]);
        // A detached HEAD has no Upstream, so there is nothing to fetch either.
        assert!(matches!(
            pull(&w.mine),
            PullOutcome::Refused {
                reason: RefusedReason::Detached,
                ..
            }
        ));
    }

    #[test]
    fn a_failed_fetch_reports_gits_message() {
        let w = world();
        git(
            &w.mine,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        );
        match fetch_upstream(s(&w.mine), false).unwrap() {
            FetchOutcome::Failed { message } => assert!(!message.is_empty()),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn worktrees_share_one_common_dir() {
        let w = world();
        let linked = w.mine.parent().unwrap().join("linked");
        git(&w.mine, &["worktree", "add", "-q", "-b", "wt", s(&linked)]);
        assert_eq!(common_dir(s(&w.mine)), common_dir(s(&linked)));
    }

    #[test]
    fn a_failed_fetch_is_not_reused() {
        let w = world();
        let url = git(&w.mine, &["remote", "get-url", "origin"]);
        git(
            &w.mine,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        );
        assert!(matches!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::Failed { .. }
        ));
        git(&w.mine, &["remote", "set-url", "origin", &url]);
        assert!(matches!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::Fetched { .. }
        ));
    }

    #[test]
    fn a_background_check_skips_a_repository_never_fetched_in() {
        let w = world();
        // A fresh clone has no FETCH_HEAD.
        assert_eq!(
            fetch_upstream(s(&w.mine), true).unwrap(),
            FetchOutcome::Skipped
        );
        assert!(matches!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::Fetched { .. }
        ));
        push_from_theirs(&w, "c.txt", "c\n");
        // Forget the reusable result, so the next call really fetches.
        let key = format!("{}\norigin", common_dir(s(&w.mine)).unwrap().display());
        *fetch_slots().get(&key).unwrap().lock().unwrap() = None;
        // Fetched once by hand, so the background may fetch now.
        assert!(matches!(
            fetch_upstream(s(&w.mine), true).unwrap(),
            FetchOutcome::Fetched { .. }
        ));
        assert_eq!(state(&w.mine).incoming, 1);
    }

    #[test]
    fn a_fetch_runs_no_hooks() {
        let w = world();
        let marker = w.mine.join("hook-ran");
        let hook = w.mine.join(".git/hooks/reference-transaction");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        make_executable(&hook);
        push_from_theirs(&w, "c.txt", "c\n");
        assert!(matches!(
            fetch_upstream(s(&w.mine), false).unwrap(),
            FetchOutcome::Fetched { .. }
        ));
        assert!(!marker.exists());
    }

    #[test]
    fn a_noisy_failing_post_merge_hook_still_reports_the_pull() {
        let w = world();
        let hook = w.mine.join(".git/hooks/post-merge");
        // About 200 KB on each of stdout and stderr: past any pipe buffer.
        std::fs::write(
            &hook,
            "#!/bin/sh\ni=0\nwhile [ $i -lt 4000 ]; do\n  echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n  echo 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' >&2\n  i=$((i+1))\ndone\nexit 1\n",
        )
        .unwrap();
        make_executable(&hook);
        push_from_theirs(&w, "c.txt", "c\n");
        let start = Instant::now();
        assert!(matches!(
            pull(&w.mine),
            PullOutcome::Pulled { count: 1, .. }
        ));
        assert!(start.elapsed() < Duration::from_secs(30));
    }

    fn make_executable(p: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn git_refusal_file_list_is_parsed() {
        let msg = "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tdir/b.txt\nPlease commit your changes or stash them before you merge.\nAborting";
        assert_eq!(files_from_git_refusal(msg), vec!["a.txt", "dir/b.txt"]);
        assert!(files_from_git_refusal("fatal: something else").is_empty());
    }
}

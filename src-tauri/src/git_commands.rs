use crate::error::AbundioError;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::OnceLock;

/// Per-repo cache of the detected default branch name.
/// Keyed by the canonicalized repo working directory path.
/// Note: this cache lives for the process lifetime. If the remote default
/// branch is renamed, the app must be restarted to pick up the change.
fn default_branch_cache() -> &'static DashMap<String, String> {
    static CACHE: OnceLock<DashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

/// Per-repo cache of successful git-repo checks.
/// Only positive results are cached; non-git directories are always
/// re-checked so that a later `git init` is picked up.
fn git_repo_cache() -> &'static DashMap<String, ()> {
    static CACHE: OnceLock<DashMap<String, ()>> = OnceLock::new();
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

fn ensure_git_repo(cwd: &str) -> Result<(), AbundioError> {
    let cache_key = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string());

    if git_repo_cache().contains_key(&cache_key) {
        return Ok(());
    }

    let status = Command::new("git")
        .args(["-C", cwd, "rev-parse", "--git-dir"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => {
            git_repo_cache().insert(cache_key, ());
            Ok(())
        }
        _ => Err(AbundioError::NotGitRepo(cwd.to_string())),
    }
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, AbundioError> {
    ensure_git_repo(cwd)?;
    let mut full_args = vec!["--no-optional-locks"];
    full_args.extend_from_slice(args);
    let mut cmd = Command::new("git");
    cmd.args(&full_args)
        .current_dir(cwd)
        .env("PATH", crate::shell_env::shell_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| AbundioError::Git(format!("Failed to run git: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AbundioError::Git(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_allow_empty(cwd: &str, args: &[&str]) -> Result<String, AbundioError> {
    ensure_git_repo(cwd)?;
    let mut full_args = vec!["--no-optional-locks"];
    full_args.extend_from_slice(args);
    let mut cmd = Command::new("git");
    cmd.args(&full_args)
        .current_dir(cwd)
        .env("PATH", crate::shell_env::shell_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| AbundioError::Git(format!("Failed to run git: {}", e)))?;

    #[cfg(debug_assertions)]
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("git {} (non-fatal): {}", args.join(" "), stderr.trim());
        }
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn detect_default_branch(cwd: &str) -> Result<String, AbundioError> {
    let cache_key = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string());

    // Return cached result if available
    if let Some(cached) = default_branch_cache().get(&cache_key) {
        return Ok(cached.clone());
    }

    // Try the remote HEAD symbolic ref first (works for any default branch name)
    if let Ok(output) = run_git(cwd, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        let trimmed = output.trim();
        if let Some(branch) = trimmed.strip_prefix("refs/remotes/origin/") {
            if !branch.is_empty() {
                default_branch_cache().insert(cache_key, branch.to_string());
                return Ok(branch.to_string());
            }
        }
    }
    // Fall back to checking common branch names locally
    if run_git(cwd, &["rev-parse", "--verify", "main"]).is_ok() {
        default_branch_cache().insert(cache_key, "main".to_string());
        return Ok("main".to_string());
    }
    if run_git(cwd, &["rev-parse", "--verify", "master"]).is_ok() {
        default_branch_cache().insert(cache_key, "master".to_string());
        return Ok("master".to_string());
    }
    Err(AbundioError::Git(
        "No default branch found".to_string(),
    ))
}

fn resolve_base_branch(cwd: &str, base_branch: Option<String>) -> Result<String, AbundioError> {
    match base_branch {
        Some(b) if !b.is_empty() => Ok(b),
        _ => detect_default_branch(cwd),
    }
}

pub fn parse_name_status(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(2, '\t');
            let status = parts.next()?.trim().to_string();
            let path = parts.next()?.trim().to_string();
            // For renames (R100\told\tnew), take the new path
            let path = if status.starts_with('R') {
                path.split('\t').last().unwrap_or(&path).to_string()
            } else {
                path
            };
            let status_char = status.chars().next()?.to_string();
            Some((status_char, path))
        })
        .collect()
}

pub fn parse_numstat(output: &str) -> Vec<(String, i32, i32)> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                return None;
            }
            let additions = parts[0].parse::<i32>().unwrap_or(0);
            let deletions = parts[1].parse::<i32>().unwrap_or(0);
            // For renames, take the new path (last part after =>)
            let path = parts[2].to_string();
            let path = if path.contains(" => ") {
                // Handle rename format: old => new or {old => new}/rest
                path.split(" => ")
                    .last()
                    .unwrap_or(&path)
                    .replace('}', "")
                    .trim()
                    .to_string()
            } else {
                path
            };
            Some((path, additions, deletions))
        })
        .collect()
}

fn get_changed_files_for_section(
    cwd: &str,
    diff_args: &[&str],
    section: &str,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    let mut name_status_args = diff_args.to_vec();
    name_status_args.push("--name-status");
    let name_status_output = run_git_allow_empty(cwd, &name_status_args)?;
    let statuses = parse_name_status(&name_status_output);

    let mut numstat_args = diff_args.to_vec();
    numstat_args.push("--numstat");
    let numstat_output = run_git_allow_empty(cwd, &numstat_args)?;
    let stats = parse_numstat(&numstat_output);

    let files: Vec<GitChangedFile> = statuses
        .into_iter()
        .map(|(status, path)| {
            let (additions, deletions) = stats
                .iter()
                .find(|(p, _, _)| p == &path)
                .map(|(_, a, d)| (*a, *d))
                .unwrap_or((0, 0));
            GitChangedFile {
                path,
                status,
                additions,
                deletions,
                section: section.to_string(),
            }
        })
        .collect();

    Ok(files)
}

#[tauri::command]
pub async fn git_changed_files(
    cwd: String,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
    tokio::task::spawn_blocking(move || {
        let base = resolve_base_branch(&cwd, base_branch)?;
        let merge_base_spec = format!("{}...HEAD", base);

        let mut all_files = Vec::new();

        // Against base branch
        if let Ok(files) =
            get_changed_files_for_section(&cwd, &["diff", &merge_base_spec], "against_base")
        {
            all_files.extend(files);
        }

        // Staged
        if let Ok(files) = get_changed_files_for_section(&cwd, &["diff", "--cached"], "staged") {
            all_files.extend(files);
        }

        // Unstaged
        if let Ok(files) = get_changed_files_for_section(&cwd, &["diff"], "unstaged") {
            all_files.extend(files);
        }

        // Untracked — from git status --short (lines starting with "?? ")
        if let Ok(output) = run_git_allow_empty(&cwd, &["-c", "core.quotePath=false", "status", "--short"]) {
            const MAX_UNTRACKED: usize = 500;
            let mut count = 0;
            for line in output.lines() {
                if !line.starts_with("?? ") {
                    continue;
                }
                if count >= MAX_UNTRACKED {
                    break;
                }
                let path = line[3..].trim().to_string();
                if path.is_empty() {
                    continue;
                }
                all_files.push(GitChangedFile {
                    path,
                    status: "?".to_string(),
                    additions: 0,
                    deletions: 0,
                    section: "untracked".to_string(),
                });
                count += 1;
            }
        }

        Ok(all_files)
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
                let git_path = format!("{}:{}", base, file_path);
                let original = run_git(&cwd, &["show", &git_path]).unwrap_or_default();
                let full_path = Path::new(&cwd).join(&file_path);
                let modified =
                    std::fs::read_to_string(&full_path).unwrap_or_default();
                (original, modified)
            }
            "staged" => {
                let head_path = format!("HEAD:{}", file_path);
                let original = run_git(&cwd, &["show", &head_path]).unwrap_or_default();
                let index_path = format!(":{}", file_path);
                let modified = run_git(&cwd, &["show", &index_path]).unwrap_or_default();
                (original, modified)
            }
            "unstaged" => {
                let index_path = format!(":{}", file_path);
                let original = run_git(&cwd, &["show", &index_path]).unwrap_or_default();
                let full_path = Path::new(&cwd).join(&file_path);
                let modified =
                    std::fs::read_to_string(&full_path).unwrap_or_default();
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
    tokio::task::spawn_blocking(move || {
        let current = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        let default = detect_default_branch(&cwd)?;

        Ok(BranchInfo {
            default_branch: default,
            current_branch: current,
        })
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_status_fingerprint(cwd: String) -> Result<String, AbundioError> {
    tokio::task::spawn_blocking(move || {
        run_git_allow_empty(&cwd, &["-c", "core.quotePath=false", "status", "--porcelain=v1"])
    })
    .await
    .map_err(|e| AbundioError::Git(format!("git task failed: {}", e)))?
}

#[tauri::command]
pub async fn git_list_branches(cwd: String) -> Result<Vec<String>, AbundioError> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&cwd, &["branch", "-a", "--format=%(refname:short)"])?;
        let branches: Vec<String> = output
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(branches)
    })
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
}

/// Resolves just the current branch name for a workspace — one `git rev-parse`
/// subprocess per workspace. Change stats are intentionally excluded here;
/// they are expensive (multiple `git diff --numstat` calls) and are already
/// computed by `git_changed_files` whenever the active workspace opens its git
/// panel, which syncs back to the workspace chip store via the frontend.
fn compute_workspace_git_summary(req: WorkspaceGitRequest) -> WorkspaceGitSummary {
    let current_branch = run_git(&req.cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|out| out.trim().to_string())
        .ok();
    WorkspaceGitSummary {
        workspace_id: req.workspace_id,
        is_git_repo: current_branch.is_some(),
        current_branch,
        changed_file_count: 0,
        additions: 0,
        deletions: 0,
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

    #[test]
    fn parse_name_status_basic() {
        let output = "M\tsrc/main.rs\nA\tsrc/new.rs\nD\tsrc/old.rs\n";
        let result = parse_name_status(output);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], ("M".to_string(), "src/main.rs".to_string()));
        assert_eq!(result[1], ("A".to_string(), "src/new.rs".to_string()));
        assert_eq!(result[2], ("D".to_string(), "src/old.rs".to_string()));
    }

    #[test]
    fn parse_name_status_rename() {
        let output = "R100\told.rs\tnew.rs\n";
        let result = parse_name_status(output);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], ("R".to_string(), "new.rs".to_string()));
    }

    #[test]
    fn parse_name_status_empty() {
        let result = parse_name_status("");
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn parse_numstat_basic() {
        let output = "10\t5\tsrc/main.rs\n3\t0\tsrc/new.rs\n";
        let result = parse_numstat(output);
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0],
            ("src/main.rs".to_string(), 10, 5)
        );
        assert_eq!(
            result[1],
            ("src/new.rs".to_string(), 3, 0)
        );
    }

    #[test]
    fn parse_numstat_binary() {
        let output = "-\t-\timage.png\n";
        let result = parse_numstat(output);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], ("image.png".to_string(), 0, 0));
    }

    #[test]
    fn parse_numstat_empty() {
        let result = parse_numstat("");
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn ensure_git_repo_rejects_non_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = ensure_git_repo(dir.path().to_str().unwrap());
        assert!(matches!(result, Err(AbundioError::NotGitRepo(_))));
    }

    #[test]
    fn ensure_git_repo_accepts_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(cwd)
            .output()
            .unwrap();
        let result = ensure_git_repo(cwd);
        assert!(result.is_ok());
    }

    /// Helper: create a temporary git repo with an initial commit.
    fn setup_temp_git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        // Use Command directly for init since .git doesn't exist yet
        Command::new("git")
            .args(["init"])
            .current_dir(cwd)
            .output()
            .unwrap();
        run_git(cwd, &["config", "user.email", "test@test.com"]).unwrap();
        run_git(cwd, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.path().join("initial.txt"), "hello\n").unwrap();
        run_git(cwd, &["add", "."]).unwrap();
        run_git(cwd, &["commit", "-m", "init"]).unwrap();
        dir
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
        assert_eq!(untracked[0].additions, 0);
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

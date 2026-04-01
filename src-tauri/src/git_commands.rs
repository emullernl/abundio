use crate::error::AbundioError;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

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

fn run_git(cwd: &str, args: &[&str]) -> Result<String, AbundioError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
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
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
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
    // Try the remote HEAD symbolic ref first (works for any default branch name)
    if let Ok(output) = run_git(cwd, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        let trimmed = output.trim();
        if let Some(branch) = trimmed.strip_prefix("refs/remotes/origin/") {
            if !branch.is_empty() {
                return Ok(branch.to_string());
            }
        }
    }
    // Fall back to checking common branch names locally
    if run_git(cwd, &["rev-parse", "--verify", "main"]).is_ok() {
        return Ok("main".to_string());
    }
    if run_git(cwd, &["rev-parse", "--verify", "master"]).is_ok() {
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
pub fn git_changed_files(
    cwd: String,
    base_branch: Option<String>,
) -> Result<Vec<GitChangedFile>, AbundioError> {
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

    // Untracked
    if let Ok(output) = run_git_allow_empty(&cwd, &["ls-files", "--others", "--exclude-standard"]) {
        for line in output.lines() {
            let path = line.trim().to_string();
            if path.is_empty() {
                continue;
            }
            let full_path = Path::new(&cwd).join(&path);
            let additions = std::fs::read_to_string(&full_path)
                .map(|content| content.lines().count() as i32)
                .unwrap_or(0);
            all_files.push(GitChangedFile {
                path,
                status: "?".to_string(),
                additions,
                deletions: 0,
                section: "untracked".to_string(),
            });
        }
    }

    Ok(all_files)
}

#[tauri::command]
pub fn git_file_diff(
    cwd: String,
    file_path: String,
    section: String,
    base_branch: Option<String>,
) -> Result<GitFileDiff, AbundioError> {
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
}

#[tauri::command]
pub fn git_branch_info(cwd: String) -> Result<BranchInfo, AbundioError> {
    let current = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    let default = detect_default_branch(&cwd)?;

    Ok(BranchInfo {
        default_branch: default,
        current_branch: current,
    })
}

#[tauri::command]
pub fn git_list_branches(cwd: String) -> Result<Vec<String>, AbundioError> {
    let output = run_git(&cwd, &["branch", "-a", "--format=%(refname:short)"])?;
    let branches: Vec<String> = output
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
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
}

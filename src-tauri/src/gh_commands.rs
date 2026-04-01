use crate::error::AbundioError;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::OnceLock;

// ── Data types ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
	pub available: bool,
	pub authenticated: bool,
	pub has_remote: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
	pub number: i32,
	pub title: String,
	pub url: String,
	pub author: String,
	pub created_at: String,
	pub updated_at: String,
	pub head_ref: String,
	pub base_ref: String,
	pub additions: i32,
	pub deletions: i32,
	pub review_decision: String,
	pub status_check_rollup: String,
	pub is_draft: bool,
	pub labels: Vec<String>,
	pub comments: i32,
	pub repository: String,
}

// ── JSON shapes from `gh` CLI ──

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrListItem {
	number: i32,
	title: String,
	url: String,
	#[serde(default)]
	author: GhAuthor,
	created_at: String,
	updated_at: String,
	#[serde(default)]
	head_ref_name: String,
	#[serde(default)]
	base_ref_name: String,
	#[serde(default)]
	additions: i32,
	#[serde(default)]
	deletions: i32,
	#[serde(default)]
	review_decision: String,
	#[serde(default)]
	status_check_rollup: Vec<GhCheckContext>,
	#[serde(default)]
	is_draft: bool,
	#[serde(default)]
	labels: Vec<GhLabel>,
	#[serde(default)]
	comments: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct GhAuthor {
	#[serde(default)]
	login: String,
}

#[derive(Debug, Deserialize)]
struct GhCheckContext {
	#[serde(default)]
	status: String,
	#[serde(default)]
	conclusion: String,
}

#[derive(Debug, Deserialize)]
struct GhLabel {
	name: String,
}

// Shape returned by `gh search prs`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSearchPrItem {
	number: i32,
	title: String,
	url: String,
	#[serde(default)]
	author: GhAuthor,
	#[serde(default)]
	created_at: String,
	#[serde(default)]
	updated_at: String,
	#[serde(default)]
	repository: GhRepository,
	#[serde(default)]
	is_draft: bool,
	#[serde(default)]
	labels: Vec<GhLabel>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GhRepository {
	#[serde(default)]
	name_with_owner: String,
}

// ── Helpers ──

fn run_gh(cwd: &str, args: &[&str]) -> Result<String, AbundioError> {
	let output = Command::new("gh")
		.args(args)
		.current_dir(cwd)
		.output()
		.map_err(|e| AbundioError::Git(format!("Failed to run gh: {}", e)))?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(AbundioError::Git(format!(
			"gh {} failed: {}",
			args.join(" "),
			stderr.trim()
		)));
	}

	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Cached result of `gh --version` + `gh auth status` (doesn't change between sessions).
static GH_AUTH_CACHE: OnceLock<(bool, bool)> = OnceLock::new();

fn gh_available_and_authenticated() -> (bool, bool) {
	*GH_AUTH_CACHE.get_or_init(|| {
		let available = Command::new("gh")
			.arg("--version")
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false);
		if !available {
			return (false, false);
		}
		let authenticated = Command::new("gh")
			.args(["auth", "status"])
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false);
		(available, authenticated)
	})
}

/// Check if any git remote points to github.com (local operation, no network).
fn has_github_remote(cwd: &str) -> bool {
	Command::new("git")
		.args(["remote", "-v"])
		.current_dir(cwd)
		.output()
		.map(|o| {
			let stdout = String::from_utf8_lossy(&o.stdout);
			stdout.contains("github.com")
		})
		.unwrap_or(false)
}

/// Derive a single rollup status from an array of check contexts.
fn rollup_status(checks: &[GhCheckContext]) -> String {
	if checks.is_empty() {
		return String::new();
	}
	let effective_status: Vec<&str> = checks
		.iter()
		.map(|c| if c.conclusion.is_empty() { c.status.as_str() } else { c.conclusion.as_str() })
		.collect();
	let all_success = effective_status.iter().all(|s| matches!(*s, "SUCCESS" | "NEUTRAL" | "SKIPPED"));
	let any_failure = effective_status.iter().any(|s| matches!(*s, "FAILURE" | "ERROR"));
	if any_failure {
		"FAILURE".to_string()
	} else if all_success {
		"SUCCESS".to_string()
	} else {
		"PENDING".to_string()
	}
}

pub fn parse_pr_list(json: &str) -> Result<Vec<PullRequest>, AbundioError> {
	let items: Vec<GhPrListItem> = serde_json::from_str(json)
		.map_err(|e| AbundioError::Git(format!("Failed to parse gh pr list output: {}", e)))?;

	Ok(items
		.into_iter()
		.map(|item| PullRequest {
			number: item.number,
			title: item.title,
			url: item.url,
			author: item.author.login,
			created_at: item.created_at,
			updated_at: item.updated_at,
			head_ref: item.head_ref_name,
			base_ref: item.base_ref_name,
			additions: item.additions,
			deletions: item.deletions,
			review_decision: item.review_decision,
			status_check_rollup: rollup_status(&item.status_check_rollup),
			is_draft: item.is_draft,
			labels: item.labels.into_iter().map(|l| l.name).collect(),
			comments: item.comments.len() as i32,
			repository: String::new(),
		})
		.collect())
}

pub fn parse_search_prs(json: &str) -> Result<Vec<PullRequest>, AbundioError> {
	let items: Vec<GhSearchPrItem> = serde_json::from_str(json)
		.map_err(|e| AbundioError::Git(format!("Failed to parse gh search output: {}", e)))?;

	Ok(items
		.into_iter()
		.map(|item| PullRequest {
			number: item.number,
			title: item.title,
			url: item.url,
			author: item.author.login,
			created_at: item.created_at,
			updated_at: item.updated_at,
			is_draft: item.is_draft,
			labels: item.labels.into_iter().map(|l| l.name).collect(),
			repository: item.repository.name_with_owner,
			..Default::default()
		})
		.collect())
}

// ── Tauri commands ──
// All commands are async to avoid blocking the main IPC thread while
// waiting for `gh` subprocess I/O (especially network calls).

fn gh_status_sync(cwd: &str) -> Result<GhStatus, AbundioError> {
	let (available, authenticated) = gh_available_and_authenticated();
	if !available {
		return Ok(GhStatus {
			available: false,
			authenticated: false,
			has_remote: false,
		});
	}
	if !authenticated {
		return Ok(GhStatus {
			available: true,
			authenticated: false,
			has_remote: false,
		});
	}

	// Local check: just scan git remotes for github.com (no network call).
	let has_remote = has_github_remote(cwd);

	Ok(GhStatus {
		available: true,
		authenticated: true,
		has_remote,
	})
}

const PR_LIST_FIELDS: &str = "number,title,url,author,createdAt,updatedAt,headRefName,baseRefName,additions,deletions,reviewDecision,statusCheckRollup,isDraft,labels,comments";

#[tauri::command]
pub async fn gh_status(cwd: String) -> Result<GhStatus, AbundioError> {
	tokio::task::spawn_blocking(move || gh_status_sync(&cwd))
		.await
		.map_err(|e| AbundioError::Git(format!("gh_status task failed: {}", e)))?
}

#[tauri::command]
pub async fn gh_review_requests(cwd: String) -> Result<Vec<PullRequest>, AbundioError> {
	tokio::task::spawn_blocking(move || {
		let output = run_gh(
			&cwd,
			&[
				"pr",
				"list",
				"--search",
				"review-requested:@me",
				"--state",
				"open",
				"--json",
				PR_LIST_FIELDS,
			],
		)?;
		parse_pr_list(&output)
	})
	.await
	.map_err(|e| AbundioError::Git(format!("gh task failed: {}", e)))?
}

#[tauri::command]
pub async fn gh_review_requests_all(cwd: String) -> Result<Vec<PullRequest>, AbundioError> {
	tokio::task::spawn_blocking(move || {
		let output = run_gh(
			&cwd,
			&[
				"search",
				"prs",
				"--review-requested=@me",
				"--state=open",
				"--json",
				"number,title,url,repository,author,createdAt,updatedAt,isDraft,labels",
			],
		)?;
		parse_search_prs(&output)
	})
	.await
	.map_err(|e| AbundioError::Git(format!("gh task failed: {}", e)))?
}

#[tauri::command]
pub async fn gh_my_prs(cwd: String) -> Result<Vec<PullRequest>, AbundioError> {
	tokio::task::spawn_blocking(move || {
		let output = run_gh(
			&cwd,
			&[
				"pr",
				"list",
				"--author",
				"@me",
				"--state",
				"open",
				"--json",
				PR_LIST_FIELDS,
			],
		)?;
		parse_pr_list(&output)
	})
	.await
	.map_err(|e| AbundioError::Git(format!("gh task failed: {}", e)))?
}

#[tauri::command]
pub async fn gh_my_prs_all(cwd: String) -> Result<Vec<PullRequest>, AbundioError> {
	tokio::task::spawn_blocking(move || {
		let output = run_gh(
			&cwd,
			&[
				"search",
				"prs",
				"--author=@me",
				"--state=open",
				"--json",
				"number,title,url,repository,author,createdAt,updatedAt,isDraft,labels",
			],
		)?;
		parse_search_prs(&output)
	})
	.await
	.map_err(|e| AbundioError::Git(format!("gh task failed: {}", e)))?
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_pr_list_basic() {
		let json = r#"[
			{
				"number": 42,
				"title": "Fix auth bug",
				"url": "https://github.com/org/repo/pull/42",
				"author": {"login": "alice"},
				"createdAt": "2026-03-28T10:00:00Z",
				"updatedAt": "2026-03-29T12:00:00Z",
				"headRefName": "fix-auth",
				"baseRefName": "main",
				"additions": 24,
				"deletions": 8,
				"reviewDecision": "APPROVED",
				"statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
				"isDraft": false,
				"labels": [{"name": "bug"}, {"name": "priority"}],
				"comments": [{}, {}]
			}
		]"#;

		let prs = parse_pr_list(json).unwrap();
		assert_eq!(prs.len(), 1);
		let pr = &prs[0];
		assert_eq!(pr.number, 42);
		assert_eq!(pr.title, "Fix auth bug");
		assert_eq!(pr.author, "alice");
		assert_eq!(pr.additions, 24);
		assert_eq!(pr.deletions, 8);
		assert_eq!(pr.review_decision, "APPROVED");
		assert_eq!(pr.status_check_rollup, "SUCCESS");
		assert!(!pr.is_draft);
		assert_eq!(pr.labels, vec!["bug", "priority"]);
		assert_eq!(pr.comments, 2);
		assert_eq!(pr.repository, "");
	}

	#[test]
	fn parse_pr_list_empty() {
		let prs = parse_pr_list("[]").unwrap();
		assert!(prs.is_empty());
	}

	#[test]
	fn parse_pr_list_draft_no_checks() {
		let json = r#"[
			{
				"number": 10,
				"title": "WIP: Refactor",
				"url": "https://github.com/org/repo/pull/10",
				"author": {"login": "bob"},
				"createdAt": "2026-03-28T10:00:00Z",
				"updatedAt": "2026-03-28T10:00:00Z",
				"isDraft": true,
				"statusCheckRollup": [],
				"labels": [],
				"comments": []
			}
		]"#;

		let prs = parse_pr_list(json).unwrap();
		assert_eq!(prs.len(), 1);
		assert!(prs[0].is_draft);
		assert_eq!(prs[0].status_check_rollup, "");
	}

	#[test]
	fn parse_pr_list_failing_checks() {
		let json = r#"[
			{
				"number": 5,
				"title": "Add feature",
				"url": "https://github.com/org/repo/pull/5",
				"author": {"login": "carol"},
				"createdAt": "2026-03-28T10:00:00Z",
				"updatedAt": "2026-03-28T10:00:00Z",
				"statusCheckRollup": [
					{"status": "COMPLETED", "conclusion": "SUCCESS"},
					{"status": "COMPLETED", "conclusion": "FAILURE"}
				],
				"labels": [],
				"comments": []
			}
		]"#;

		let prs = parse_pr_list(json).unwrap();
		assert_eq!(prs[0].status_check_rollup, "FAILURE");
	}

	#[test]
	fn parse_search_prs_basic() {
		let json = r#"[
			{
				"number": 87,
				"title": "Update schema",
				"url": "https://github.com/org/lib/pull/87",
				"author": {"login": "dave"},
				"createdAt": "2026-03-25T08:00:00Z",
				"updatedAt": "2026-03-26T14:00:00Z",
				"repository": {"nameWithOwner": "org/lib"},
				"isDraft": false,
				"labels": [{"name": "enhancement"}]
			}
		]"#;

		let prs = parse_search_prs(json).unwrap();
		assert_eq!(prs.len(), 1);
		let pr = &prs[0];
		assert_eq!(pr.number, 87);
		assert_eq!(pr.repository, "org/lib");
		assert_eq!(pr.author, "dave");
		assert_eq!(pr.labels, vec!["enhancement"]);
		// Search results don't include these fields — verify defaults
		assert_eq!(pr.additions, 0);
		assert_eq!(pr.review_decision, "");
		assert_eq!(pr.status_check_rollup, "");
	}

	#[test]
	fn parse_search_prs_empty() {
		let prs = parse_search_prs("[]").unwrap();
		assert!(prs.is_empty());
	}

	#[test]
	fn rollup_status_all_success() {
		let checks = vec![
			GhCheckContext { status: "COMPLETED".to_string(), conclusion: "SUCCESS".to_string() },
			GhCheckContext { status: "COMPLETED".to_string(), conclusion: "NEUTRAL".to_string() },
			GhCheckContext { status: "COMPLETED".to_string(), conclusion: "SKIPPED".to_string() },
		];
		assert_eq!(rollup_status(&checks), "SUCCESS");
	}

	#[test]
	fn rollup_status_pending() {
		let checks = vec![
			GhCheckContext { status: "COMPLETED".to_string(), conclusion: "SUCCESS".to_string() },
			GhCheckContext { status: "IN_PROGRESS".to_string(), conclusion: String::new() },
		];
		assert_eq!(rollup_status(&checks), "PENDING");
	}

	#[test]
	fn rollup_status_empty() {
		let checks: Vec<GhCheckContext> = vec![];
		assert_eq!(rollup_status(&checks), "");
	}
}

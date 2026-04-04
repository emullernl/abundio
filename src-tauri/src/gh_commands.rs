use crate::error::AbundioError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::RwLock;

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
	let mut cmd = Command::new("gh");
	cmd.args(args)
		.current_dir(cwd)
		.env("PATH", crate::shell_env::shell_path());
	#[cfg(target_os = "windows")]
	cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	let output = cmd
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

/// Cached result of `gh --version` + `gh auth status`.
/// Uses RwLock so it can be refreshed when the user re-checks status
/// (e.g. after running `gh auth login`).
static GH_AUTH_CACHE: RwLock<Option<(bool, bool)>> = RwLock::new(None);

fn gh_available_and_authenticated() -> (bool, bool) {
	if let Some(cached) = *GH_AUTH_CACHE.read().unwrap() {
		return cached;
	}
	let result = check_gh_auth();
	*GH_AUTH_CACHE.write().unwrap() = Some(result);
	result
}

fn invalidate_gh_auth_cache() {
	*GH_AUTH_CACHE.write().unwrap() = None;
}

fn check_gh_auth() -> (bool, bool) {
	let path = crate::shell_env::shell_path();
	let mut cmd = Command::new("gh");
	cmd.arg("--version").env("PATH", path);
	#[cfg(target_os = "windows")]
	cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	let available = cmd.output().map(|o| o.status.success()).unwrap_or(false);
	if !available {
		return (false, false);
	}
	let mut cmd = Command::new("gh");
	cmd.args(["auth", "status"]).env("PATH", path);
	#[cfg(target_os = "windows")]
	cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	let authenticated = cmd.output().map(|o| o.status.success()).unwrap_or(false);
	(available, authenticated)
}

/// Check if any git remote points to github.com (local operation, no network).
fn has_github_remote(cwd: &str) -> bool {
	let mut cmd = Command::new("git");
	cmd.args(["remote", "-v"]).current_dir(cwd);
	#[cfg(target_os = "windows")]
	cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	cmd.output()
		.map(|o| {
			let stdout = String::from_utf8_lossy(&o.stdout);
			stdout.lines().any(|l| {
				let url = l.split_whitespace().nth(1).unwrap_or("");
				url.contains("github.com/") || url.contains("github.com:")
			})
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

// ── GraphQL enrichment for search results ──

/// GraphQL response shape for batch PR enrichment.
/// Uses aliases like `repo0`, `pr42` to map back to PRs.
#[derive(Debug, Deserialize)]
struct GqlResponse {
	#[serde(default)]
	data: HashMap<String, HashMap<String, GqlPrNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPrNode {
	#[serde(default)]
	review_decision: Option<String>,
	#[serde(default)]
	commits: Option<GqlCommits>,
}

#[derive(Debug, Deserialize)]
struct GqlCommits {
	#[serde(default)]
	nodes: Vec<GqlCommitWrapper>,
}

#[derive(Debug, Deserialize)]
struct GqlCommitWrapper {
	commit: GqlCommit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCommit {
	#[serde(default)]
	status_check_rollup: Option<GqlStatusCheckRollup>,
}

#[derive(Debug, Deserialize)]
struct GqlStatusCheckRollup {
	#[serde(default)]
	contexts: GqlContexts,
}

#[derive(Debug, Deserialize, Default)]
struct GqlContexts {
	#[serde(default)]
	nodes: Vec<GqlCheckNode>,
}

/// Flattened union of CheckRun and StatusContext fields.
#[derive(Debug, Deserialize)]
struct GqlCheckNode {
	// CheckRun fields
	#[serde(default)]
	status: Option<String>,
	#[serde(default)]
	conclusion: Option<String>,
	// StatusContext field
	#[serde(default)]
	state: Option<String>,
}

impl GqlCheckNode {
	fn to_check_context(&self) -> GhCheckContext {
		// StatusContext uses `state` (SUCCESS, FAILURE, PENDING, ERROR)
		if let Some(state) = &self.state {
			if self.status.is_none() && self.conclusion.is_none() {
				return GhCheckContext {
					status: "COMPLETED".to_string(),
					conclusion: state.clone(),
				};
			}
		}
		// CheckRun uses status + conclusion
		GhCheckContext {
			status: self.status.clone().unwrap_or_default(),
			conclusion: self.conclusion.clone().unwrap_or_default(),
		}
	}
}

/// Build a GraphQL query to batch-fetch reviewDecision and status checks
/// for a set of PRs grouped by repository.
/// Returns (query_string, ordered_repo_names) so the caller can map aliases back.
fn build_enrichment_query(prs: &[PullRequest]) -> Option<(String, Vec<String>)> {
	if prs.is_empty() {
		return None;
	}

	// Group PR numbers by repository, preserving insertion order
	let mut repo_order: Vec<String> = Vec::new();
	let mut repo_prs: HashMap<String, Vec<i32>> = HashMap::new();
	for pr in prs {
		if !pr.repository.is_empty() {
			if !repo_prs.contains_key(&pr.repository) {
				repo_order.push(pr.repository.clone());
			}
			repo_prs.entry(pr.repository.clone()).or_default().push(pr.number);
		}
	}

	if repo_order.is_empty() {
		return None;
	}

	let mut query = String::from("{ ");
	for (i, repo) in repo_order.iter().enumerate() {
		let parts: Vec<&str> = repo.splitn(2, '/').collect();
		if parts.len() != 2 {
			continue;
		}
		let (owner, name) = (parts[0], parts[1]);
		query.push_str(&format!(
			"repo{i}: repository(owner: \"{owner}\", name: \"{name}\") {{ "
		));
		for num in &repo_prs[repo] {
			query.push_str(&format!(
				"pr{num}: pullRequest(number: {num}) {{ reviewDecision commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first: 100) {{ nodes {{ __typename ... on CheckRun {{ status conclusion }} ... on StatusContext {{ state }} }} }} }} }} }} }} }} "
			));
		}
		query.push_str("} ");
	}
	query.push('}');

	Some((query, repo_order))
}

/// Enrich search-result PRs with reviewDecision and statusCheckRollup
/// via a single GraphQL API call. Best-effort: silently returns on failure.
fn enrich_search_prs(cwd: &str, prs: &mut [PullRequest]) {
	let (query, repo_order) = match build_enrichment_query(prs) {
		Some(qr) => qr,
		None => return,
	};

	let output = match run_gh(cwd, &["api", "graphql", "-f", &format!("query={}", query)]) {
		Ok(o) => o,
		Err(_) => return, // best-effort
	};

	let response: GqlResponse = match serde_json::from_str(&output) {
		Ok(r) => r,
		Err(_) => return,
	};

	// Build a lookup: (repo, number) -> (reviewDecision, statusRollup)
	let mut lookup: HashMap<(String, i32), (String, String)> = HashMap::new();
	for (repo_alias, pr_map) in &response.data {
		let repo_idx: usize = match repo_alias.strip_prefix("repo").and_then(|s| s.parse().ok()) {
			Some(idx) => idx,
			None => continue,
		};

		let repo_name = match repo_order.get(repo_idx) {
			Some(name) => name.clone(),
			None => continue,
		};

		for (pr_alias, node) in pr_map {
			let pr_num: i32 = match pr_alias.strip_prefix("pr").and_then(|s| s.parse().ok()) {
				Some(n) => n,
				None => continue,
			};

			let review = node
				.review_decision
				.clone()
				.unwrap_or_default();

			let status = node
				.commits
				.as_ref()
				.and_then(|c| c.nodes.first())
				.and_then(|w| w.commit.status_check_rollup.as_ref())
				.map(|r| {
					let checks: Vec<GhCheckContext> =
						r.contexts.nodes.iter().map(|n| n.to_check_context()).collect();
					rollup_status(&checks)
				})
				.unwrap_or_default();

			lookup.insert((repo_name.clone(), pr_num), (review, status));
		}
	}

	// Apply enrichment
	for pr in prs.iter_mut() {
		if let Some((review, status)) = lookup.get(&(pr.repository.clone(), pr.number)) {
			pr.review_decision = review.clone();
			pr.status_check_rollup = status.clone();
		}
	}
}

// ── Tauri commands ──
// All commands are async to avoid blocking the main IPC thread while
// waiting for `gh` subprocess I/O (especially network calls).

fn gh_status_sync(cwd: &str) -> Result<GhStatus, AbundioError> {
	invalidate_gh_auth_cache();
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

const PR_LIST_FIELDS: &str = "number,title,url,author,createdAt,updatedAt,headRefName,baseRefName,additions,deletions,reviewDecision,statusCheckRollup,isDraft,labels";
const PR_LIST_LIMIT: &str = "100";

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
				"--limit",
				PR_LIST_LIMIT,
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
				&format!("--limit={}", PR_LIST_LIMIT),
				"--json",
				"number,title,url,repository,author,createdAt,updatedAt,isDraft,labels",
			],
		)?;
		let mut prs = parse_search_prs(&output)?;
		enrich_search_prs(&cwd, &mut prs);
		Ok(prs)
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
				"--limit",
				PR_LIST_LIMIT,
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
				&format!("--limit={}", PR_LIST_LIMIT),
				"--json",
				"number,title,url,repository,author,createdAt,updatedAt,isDraft,labels",
			],
		)?;
		let mut prs = parse_search_prs(&output)?;
		enrich_search_prs(&cwd, &mut prs);
		Ok(prs)
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
				"labels": [{"name": "bug"}, {"name": "priority"}]
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
				"labels": []
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
				"labels": []
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

	#[test]
	fn build_enrichment_query_empty_prs() {
		let prs: Vec<PullRequest> = vec![];
		assert!(build_enrichment_query(&prs).is_none());
	}

	#[test]
	fn build_enrichment_query_no_repos() {
		let prs = vec![PullRequest {
			number: 1,
			title: "test".to_string(),
			repository: String::new(), // no repo
			..Default::default()
		}];
		assert!(build_enrichment_query(&prs).is_none());
	}

	#[test]
	fn build_enrichment_query_generates_valid_query() {
		let prs = vec![
			PullRequest {
				number: 42,
				repository: "org/repo".to_string(),
				..Default::default()
			},
			PullRequest {
				number: 10,
				repository: "org/repo".to_string(),
				..Default::default()
			},
			PullRequest {
				number: 5,
				repository: "other/lib".to_string(),
				..Default::default()
			},
		];
		let (query, repo_order) = build_enrichment_query(&prs).unwrap();
		assert!(query.contains("repository(owner: \"org\", name: \"repo\")"));
		assert!(query.contains("repository(owner: \"other\", name: \"lib\")"));
		assert!(query.contains("pr42:"));
		assert!(query.contains("pr10:"));
		assert!(query.contains("pr5:"));
		assert!(query.contains("reviewDecision"));
		// Verify deterministic ordering matches insertion order
		assert_eq!(repo_order, vec!["org/repo", "other/lib"]);
	}

	#[test]
	fn parse_gql_response_and_enrich() {
		let gql_json = r#"{
			"data": {
				"repo0": {
					"pr42": {
						"reviewDecision": "APPROVED",
						"commits": {
							"nodes": [{
								"commit": {
									"statusCheckRollup": {
										"contexts": {
											"nodes": [
												{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
												{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}
											]
										}
									}
								}
							}]
						}
					},
					"pr10": {
						"reviewDecision": "CHANGES_REQUESTED",
						"commits": {
							"nodes": [{
								"commit": {
									"statusCheckRollup": {
										"contexts": {
											"nodes": [
												{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"}
											]
										}
									}
								}
							}]
						}
					}
				}
			}
		}"#;

		let response: GqlResponse = serde_json::from_str(gql_json).unwrap();
		assert!(response.data.contains_key("repo0"));

		let repo = &response.data["repo0"];
		let pr42 = &repo["pr42"];
		assert_eq!(pr42.review_decision, Some("APPROVED".to_string()));

		let pr10 = &repo["pr10"];
		assert_eq!(pr10.review_decision, Some("CHANGES_REQUESTED".to_string()));

		// Verify check context conversion
		let checks: Vec<GhCheckContext> = pr10
			.commits.as_ref().unwrap()
			.nodes[0].commit
			.status_check_rollup.as_ref().unwrap()
			.contexts.nodes.iter()
			.map(|n| n.to_check_context())
			.collect();
		assert_eq!(rollup_status(&checks), "FAILURE");
	}

	#[test]
	fn parse_gql_status_context_variant() {
		let node = GqlCheckNode {
			status: None,
			conclusion: None,
			state: Some("SUCCESS".to_string()),
		};
		let ctx = node.to_check_context();
		assert_eq!(ctx.conclusion, "SUCCESS");
	}

	#[test]
	fn parse_gql_check_run_variant() {
		let node = GqlCheckNode {
			status: Some("COMPLETED".to_string()),
			conclusion: Some("FAILURE".to_string()),
			state: None,
		};
		let ctx = node.to_check_context();
		assert_eq!(ctx.status, "COMPLETED");
		assert_eq!(ctx.conclusion, "FAILURE");
	}
}

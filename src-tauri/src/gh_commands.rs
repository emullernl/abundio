//! GitHub PR fetching via the `gh` CLI.
//!
//! All PR data is fetched by the app-global `pr_poller` (see `pr_poller.rs`)
//! through **one** `gh api graphql` call returning both lists — the user's own
//! open PRs and PRs where review is requested of them — each carrying CI status
//! (`statusCheckRollup`) and approval status (`reviewDecision`). This module
//! owns the gh runner, the availability/auth cache, the combined query, and the
//! response parser. All-vs-Repo filtering happens client-side. See ADR-0019.

use crate::error::AbundioError;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

// ── Output type (frontend-bound) ──

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

// ── gh runner ──

/// Run `gh` with `args` from `cwd` (or the home dir when `cwd` is empty —
/// account-wide queries are repo-independent). `PATH` is forced to the login
/// shell's PATH so `gh` resolves the same way it would in a terminal.
pub fn run_gh(cwd: &str, args: &[&str]) -> Result<String, AbundioError> {
	let mut cmd = Command::new("gh");
	cmd.args(args).env("PATH", crate::shell_env::shell_path());
	if cwd.is_empty() {
		cmd.current_dir(dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/")));
	} else {
		cmd.current_dir(cwd);
	}
	#[cfg(target_os = "windows")]
	cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
	let output = cmd
		.output()
		.map_err(|e| AbundioError::Git(format!("Failed to run gh: {}", e)))?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		let stderr = stderr.trim();
		// Offline / can't-reach-GitHub failures carry a raw transport error (and,
		// for `gh api graphql`, the entire echoed query) that is useless to the
		// user. Collapse those to one human-readable line. See ADR-0019.
		if let Some(friendly) = offline_message(stderr) {
			return Err(AbundioError::Git(friendly.to_string()));
		}
		return Err(AbundioError::Git(format!(
			"gh {} failed: {}",
			args.join(" "),
			stderr
		)));
	}

	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Detect the family of `gh` failures caused by the machine being offline or
/// otherwise unable to reach GitHub, and map them to a short, friendly message.
/// Returns `None` for everything else (auth errors, rate limits, bad queries…)
/// so those still surface their original detail.
fn offline_message(stderr: &str) -> Option<&'static str> {
	// Lower-cased substring match across the transport-layer errors Go's net
	// stack emits on each platform when a request can't reach the host.
	const NETWORK_MARKERS: &[&str] = &[
		"dial tcp",                            // generic Go dial failure
		"no such host",                        // DNS lookup failed (offline)
		"could not resolve host",              // curl/libc DNS failure
		"temporary failure in name resolution", // glibc DNS failure (Linux)
		"network is unreachable",              // no route (Unix)
		"network is down",                     // interface down (Unix)
		"connection refused",
		"connection attempt failed",           // Windows WSAETIMEDOUT (connectex)
		"i/o timeout",
		"tls handshake timeout",
		"server misbehaving",                  // Go resolver, no DNS reachable
	];
	let lower = stderr.to_lowercase();
	NETWORK_MARKERS
		.iter()
		.any(|m| lower.contains(m))
		.then_some("Can't reach GitHub — check your internet connection.")
}

// ── availability / auth cache ──

/// Cached result of `gh --version` + `gh auth status`. Invalidated on manual
/// refresh (e.g. after the user runs `gh auth login`).
static GH_AUTH_CACHE: RwLock<Option<(bool, bool)>> = RwLock::new(None);

pub fn gh_available_and_authenticated() -> (bool, bool) {
	if let Some(cached) = *GH_AUTH_CACHE.read().unwrap() {
		return cached;
	}
	let result = check_gh_auth();
	*GH_AUTH_CACHE.write().unwrap() = Some(result);
	result
}

pub fn invalidate_gh_auth_cache() {
	*GH_AUTH_CACHE.write().unwrap() = None;
}

fn check_gh_auth() -> (bool, bool) {
	let path = crate::shell_env::shell_path();
	let mut cmd = Command::new("gh");
	cmd.arg("--version").env("PATH", path);
	#[cfg(target_os = "windows")]
	cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
	let available = cmd.output().map(|o| o.status.success()).unwrap_or(false);
	if !available {
		return (false, false);
	}
	let mut cmd = Command::new("gh");
	cmd.args(["auth", "status"]).env("PATH", path);
	#[cfg(target_os = "windows")]
	cmd.creation_flags(crate::shell_env::CREATE_NO_WINDOW);
	let authenticated = cmd.output().map(|o| o.status.success()).unwrap_or(false);
	(available, authenticated)
}

// ── Combined GraphQL query ──

/// PR field set, as an inline fragment on `PullRequest` (the `search` connection
/// returns a union — `is:pr` guarantees only PR nodes, the fragment is for
/// type-correctness). `statusCheckRollup { state }` gives the rolled-up CI state
/// directly, so we don't fold individual check contexts.
const PR_FIELDS: &str = "... on PullRequest { number title url isDraft createdAt updatedAt additions deletions author { login } repository { nameWithOwner } headRefName baseRefName reviewDecision labels(first: 20) { nodes { name } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }";

/// `first: 100` per list = parity with the previous `--limit 100`.
const PR_LIMIT: u32 = 100;

fn build_combined_query() -> String {
	format!(
		"query {{ reviewRequested: search(query: \"is:open is:pr review-requested:@me archived:false\", type: ISSUE, first: {limit}) {{ nodes {{ {fields} }} }} mine: search(query: \"is:open is:pr author:@me archived:false\", type: ISSUE, first: {limit}) {{ nodes {{ {fields} }} }} }}",
		limit = PR_LIMIT,
		fields = PR_FIELDS,
	)
}

/// Run the single combined query from the home dir. Returns
/// `(review_requested, mine)`.
pub fn fetch_prs() -> Result<(Vec<PullRequest>, Vec<PullRequest>), AbundioError> {
	let query = build_combined_query();
	let output = run_gh("", &["api", "graphql", "-f", &format!("query={}", query)])?;
	parse_combined_prs(&output)
}

// ── GraphQL response shapes ──

#[derive(Debug, Deserialize)]
struct GqlResponse {
	data: GqlData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlData {
	#[serde(default)]
	review_requested: GqlConnection,
	#[serde(default)]
	mine: GqlConnection,
}

#[derive(Debug, Deserialize, Default)]
struct GqlConnection {
	#[serde(default)]
	nodes: Vec<GqlPrNode>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlPrNode {
	#[serde(default)]
	number: i32,
	#[serde(default)]
	title: String,
	#[serde(default)]
	url: String,
	#[serde(default)]
	is_draft: bool,
	#[serde(default)]
	created_at: String,
	#[serde(default)]
	updated_at: String,
	#[serde(default)]
	additions: i32,
	#[serde(default)]
	deletions: i32,
	#[serde(default)]
	author: GqlAuthor,
	#[serde(default)]
	repository: GqlRepository,
	#[serde(default)]
	head_ref_name: String,
	#[serde(default)]
	base_ref_name: String,
	#[serde(default)]
	review_decision: Option<String>,
	#[serde(default)]
	labels: GqlLabels,
	#[serde(default)]
	commits: GqlCommits,
}

#[derive(Debug, Deserialize, Default)]
struct GqlAuthor {
	#[serde(default)]
	login: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlRepository {
	#[serde(default)]
	name_with_owner: String,
}

#[derive(Debug, Deserialize, Default)]
struct GqlLabels {
	#[serde(default)]
	nodes: Vec<GqlLabel>,
}

#[derive(Debug, Deserialize)]
struct GqlLabel {
	#[serde(default)]
	name: String,
}

#[derive(Debug, Deserialize, Default)]
struct GqlCommits {
	#[serde(default)]
	nodes: Vec<GqlCommitWrapper>,
}

#[derive(Debug, Deserialize)]
struct GqlCommitWrapper {
	#[serde(default)]
	commit: GqlCommit,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GqlCommit {
	#[serde(default)]
	status_check_rollup: Option<GqlRollup>,
}

#[derive(Debug, Deserialize)]
struct GqlRollup {
	#[serde(default)]
	state: String,
}

/// Map GitHub's `StatusState` enum to the SUCCESS/FAILURE/PENDING set the
/// frontend `CiDot` renders. Empty string = no checks (no dot).
fn map_rollup_state(state: &str) -> String {
	match state {
		"SUCCESS" => "SUCCESS",
		"FAILURE" | "ERROR" => "FAILURE",
		"PENDING" | "EXPECTED" => "PENDING",
		_ => "",
	}
	.to_string()
}

fn node_to_pr(node: GqlPrNode) -> PullRequest {
	let status_check_rollup = node
		.commits
		.nodes
		.first()
		.and_then(|w| w.commit.status_check_rollup.as_ref())
		.map(|r| map_rollup_state(&r.state))
		.unwrap_or_default();

	PullRequest {
		number: node.number,
		title: node.title,
		url: node.url,
		author: node.author.login,
		created_at: node.created_at,
		updated_at: node.updated_at,
		head_ref: node.head_ref_name,
		base_ref: node.base_ref_name,
		additions: node.additions,
		deletions: node.deletions,
		review_decision: node.review_decision.unwrap_or_default(),
		status_check_rollup,
		is_draft: node.is_draft,
		labels: node.labels.nodes.into_iter().map(|l| l.name).collect(),
		repository: node.repository.name_with_owner,
	}
}

/// Parse the combined-query response into `(review_requested, mine)`. Nodes with
/// `number == 0` (a non-PR union member that slipped past the `is:pr` filter)
/// are dropped.
pub fn parse_combined_prs(json: &str) -> Result<(Vec<PullRequest>, Vec<PullRequest>), AbundioError> {
	let resp: GqlResponse = serde_json::from_str(json).map_err(|e| {
		// `gh` exited 0 but its stdout isn't the shape we expect — truncated
		// JSON, a captive-portal HTML page, an unexpected schema, etc. The serde
		// detail is useless to the user, so show a friendly line and keep the raw
		// reason in the log for debugging.
		eprintln!("gh graphql parse error: {} — body: {}", e, json);
		AbundioError::Git("Couldn't read GitHub's response — try refreshing.".to_string())
	})?;
	let to_prs = |conn: GqlConnection| -> Vec<PullRequest> {
		conn.nodes
			.into_iter()
			.filter(|n| n.number > 0)
			.map(node_to_pr)
			.collect()
	};
	Ok((to_prs(resp.data.review_requested), to_prs(resp.data.mine)))
}

#[cfg(test)]
mod tests {
	use super::*;

	const SAMPLE: &str = r#"{
		"data": {
			"reviewRequested": {
				"nodes": [
					{
						"number": 42,
						"title": "Fix auth bug",
						"url": "https://github.com/org/repo/pull/42",
						"isDraft": false,
						"createdAt": "2026-03-28T10:00:00Z",
						"updatedAt": "2026-03-29T12:00:00Z",
						"additions": 24,
						"deletions": 8,
						"author": {"login": "alice"},
						"repository": {"nameWithOwner": "org/repo"},
						"headRefName": "fix-auth",
						"baseRefName": "main",
						"reviewDecision": "APPROVED",
						"labels": {"nodes": [{"name": "bug"}, {"name": "priority"}]},
						"commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}
					}
				]
			},
			"mine": {
				"nodes": [
					{
						"number": 10,
						"title": "WIP: Refactor",
						"url": "https://github.com/org/repo/pull/10",
						"isDraft": true,
						"author": {"login": "bob"},
						"repository": {"nameWithOwner": "org/lib"},
						"reviewDecision": null,
						"commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE"}}}]}
					},
					{
						"number": 0,
						"title": "an issue, not a PR"
					}
				]
			}
		}
	}"#;

	#[test]
	fn parse_combined_basic() {
		let (review, _mine) = parse_combined_prs(SAMPLE).unwrap();
		assert_eq!(review.len(), 1);
		let pr = &review[0];
		assert_eq!(pr.number, 42);
		assert_eq!(pr.title, "Fix auth bug");
		assert_eq!(pr.author, "alice");
		assert_eq!(pr.repository, "org/repo");
		assert_eq!(pr.additions, 24);
		assert_eq!(pr.deletions, 8);
		assert_eq!(pr.head_ref, "fix-auth");
		assert_eq!(pr.base_ref, "main");
		assert_eq!(pr.review_decision, "APPROVED");
		assert_eq!(pr.status_check_rollup, "SUCCESS");
		assert_eq!(pr.labels, vec!["bug", "priority"]);
		assert!(!pr.is_draft);
	}

	#[test]
	fn parse_combined_mine_and_drops_non_pr() {
		let (_, mine) = parse_combined_prs(SAMPLE).unwrap();
		// number:0 node is filtered out
		assert_eq!(mine.len(), 1);
		let pr = &mine[0];
		assert_eq!(pr.number, 10);
		assert!(pr.is_draft);
		assert_eq!(pr.repository, "org/lib");
		assert_eq!(pr.review_decision, ""); // null → empty
		assert_eq!(pr.status_check_rollup, "FAILURE");
		assert!(pr.labels.is_empty());
	}

	#[test]
	fn parse_combined_empty() {
		let (review, mine) =
			parse_combined_prs(r#"{"data":{"reviewRequested":{"nodes":[]},"mine":{"nodes":[]}}}"#)
				.unwrap();
		assert!(review.is_empty());
		assert!(mine.is_empty());
	}

	#[test]
	fn parse_combined_no_checks() {
		let json = r#"{"data":{"reviewRequested":{"nodes":[]},"mine":{"nodes":[
			{"number": 5, "title": "no checks", "repository": {"nameWithOwner": "o/r"},
			 "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}}
		]}}}"#;
		let (_, mine) = parse_combined_prs(json).unwrap();
		assert_eq!(mine.len(), 1);
		assert_eq!(mine[0].status_check_rollup, "");
	}

	#[test]
	fn rollup_state_mapping() {
		assert_eq!(map_rollup_state("SUCCESS"), "SUCCESS");
		assert_eq!(map_rollup_state("FAILURE"), "FAILURE");
		assert_eq!(map_rollup_state("ERROR"), "FAILURE");
		assert_eq!(map_rollup_state("PENDING"), "PENDING");
		assert_eq!(map_rollup_state("EXPECTED"), "PENDING");
		assert_eq!(map_rollup_state("WHATEVER"), "");
	}

	#[test]
	fn build_query_contains_both_searches() {
		let q = build_combined_query();
		assert!(q.contains("review-requested:@me"));
		assert!(q.contains("author:@me"));
		assert!(q.contains("reviewDecision"));
		assert!(q.contains("statusCheckRollup"));
	}

	#[test]
	fn parse_combined_unparseable_is_friendly() {
		// Non-JSON noise (e.g. a captive-portal page) and JSON missing the
		// expected shape both yield the friendly message, never a serde dump.
		for bad in [
			"<html>Login to continue</html>",
			"",
			r#"{"errors":[{"message":"Something went wrong"}]}"#, // no `data`
		] {
			let AbundioError::Git(msg) = parse_combined_prs(bad).unwrap_err() else {
				panic!("expected Git error for input: {bad}");
			};
			assert_eq!(
				msg, "Couldn't read GitHub's response — try refreshing.",
				"input: {bad}"
			);
		}
	}

	#[test]
	fn offline_message_detects_windows_connectex() {
		// The exact shape from the user's offline report (Windows).
		let stderr = "gh: Post \"https://api.github.com/graphql\": dial tcp 140.82.121.5:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.";
		assert_eq!(
			offline_message(stderr),
			Some("Can't reach GitHub — check your internet connection.")
		);
	}

	#[test]
	fn offline_message_detects_dns_and_unreachable() {
		assert!(offline_message("dial tcp: lookup api.github.com: no such host").is_some());
		assert!(
			offline_message("dial tcp 140.82.121.6:443: connect: network is unreachable").is_some()
		);
		assert!(offline_message("Could not resolve host: github.com").is_some());
		assert!(
			offline_message("dial tcp: lookup api.github.com: Temporary failure in name resolution")
				.is_some()
		);
	}

	#[test]
	fn offline_message_ignores_non_network_errors() {
		// Auth / API errors must keep their original detail.
		assert!(offline_message("gh: Bad credentials (HTTP 401)").is_none());
		assert!(offline_message("GraphQL: Field 'foo' doesn't exist on type 'PullRequest'").is_none());
		assert!(offline_message("API rate limit exceeded").is_none());
	}
}

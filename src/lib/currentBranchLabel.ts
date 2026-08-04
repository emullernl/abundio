/**
 * Presentation shape for the Status bar's current-branch segment.
 *
 * `prefix` carries everything up to and including the last `/` so the segment
 * can dim it — on `feature/status-bar` the eye should land on `status-bar`.
 */
export type BranchLabel =
	| { kind: "branch"; prefix: string; leaf: string; full: string }
	| { kind: "detached" };

/**
 * Picks the branch string the status bar should render for a workspace.
 *
 * Deliberately reads only the per-workspace git store: it is keyed by
 * workspace id, so it can never show workspace A's branch under workspace B's
 * name during a switch, and `applyBundle` writes into it on every scheduler
 * push (background workspaces included), so it is never staler than
 * `gitChangesStore`'s active-workspace singleton.
 *
 * A missing entry and a known non-repo both yield `null` — the segment must
 * not inherit whatever the previously-active workspace had.
 */
export function pickBranchSource(
	info: { isGitRepo: boolean; currentBranch: string | null } | null | undefined,
): string | null {
	if (!info?.isGitRepo) return null;
	return info.currentBranch;
}

/**
 * Normalises a raw current-branch string into something renderable.
 *
 * `"HEAD"` from the Rust side means a genuinely **detached** HEAD and nothing
 * else — `head_branch_name` (`git_libgit2.rs`) resolves an unborn HEAD to its
 * intended branch name, so a freshly `git init`'d repo reports `main` rather
 * than landing here. Collapse the sentinel so a "branch" called `HEAD` never
 * reaches the UI.
 *
 * Returns `null` when there is nothing to show (not a repo, not loaded yet) —
 * the caller hides the segment and its separator entirely.
 */
export function branchLabel(
	raw: string | null | undefined,
): BranchLabel | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	if (trimmed === "HEAD") return { kind: "detached" };

	const slashIdx = trimmed.lastIndexOf("/");
	// A trailing slash isn't a real prefix — it would leave an empty leaf.
	if (slashIdx === -1 || slashIdx === trimmed.length - 1) {
		return { kind: "branch", prefix: "", leaf: trimmed, full: trimmed };
	}
	return {
		kind: "branch",
		prefix: trimmed.slice(0, slashIdx + 1),
		leaf: trimmed.slice(slashIdx + 1),
		full: trimmed,
	};
}

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
 * Normalises a raw current-branch string into something renderable.
 *
 * The two sources disagree on a detached HEAD: `git_libgit2::branch_info`
 * yields the literal string `"HEAD"`, while `current_branch_only` yields
 * `None`. Both mean "no branch checked out", so collapse them here rather
 * than letting a branch called `HEAD` reach the UI.
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

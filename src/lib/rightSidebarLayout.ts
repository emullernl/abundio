/**
 * Height split of the Right sidebar: tab content, then the two **Anchored
 * sections** — Commits and Pull Requests — each with a divider above it.
 *
 * Two stored numbers, both fractions of the sidebar's height:
 *  - `prRatio` — where the PR section starts. It predates Commits and
 *    keeps its meaning, so a user's tuned PR height survives the upgrade.
 *  - `commitsShare` — Commits' height, carved out of the space above
 *    the PR section (the tab content gives it up, not the PRs).
 *
 * A collapsed section has no share (it pins its header); its height goes to
 * the tab content. Shares are flex-grow weights, so they need not sum to 1.
 */

/** No expanded area is dragged or squeezed below this share. */
export const MIN_SHARE = 0.1;

export interface RightSidebarShares {
	tab: number;
	commits: number;
	pr: number;
}

export function rightSidebarShares(opts: {
	prRatio: number;
	commitsShare: number;
	commitsCollapsed: boolean;
	prCollapsed: boolean;
}): RightSidebarShares {
	const pr = opts.prCollapsed ? 0 : 1 - opts.prRatio;
	let commits = opts.commitsCollapsed ? 0 : opts.commitsShare;
	// A tall PR section plus the commits share can leave the tab content
	// nothing; the commits give way first, down to the floor.
	if (commits > 0 && 1 - pr - commits < MIN_SHARE) {
		commits = Math.max(MIN_SHARE, 1 - pr - MIN_SHARE);
	}
	const tab = Math.max(MIN_SHARE, 1 - pr - commits);
	return { tab, commits, pr };
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

/** Dragging the divider above Commits to height fraction `y`: the tab
 *  content ends at `y`, the commits fill down to the PR section (or to the
 *  bottom when PRs are collapsed). */
export function commitsShareFromDrag(y: number, prShare: number): number {
	const room = 1 - prShare;
	return clamp(room - y, MIN_SHARE, Math.max(MIN_SHARE, room - MIN_SHARE));
}

/** Dragging the divider above Pull Requests to height fraction `y`: the PR
 *  section starts at `y`, and the commits keep their height, so the tab
 *  content absorbs the change. */
export function prRatioFromDrag(y: number, commitsShare: number): number {
	const hi = 1 - MIN_SHARE;
	// Never let the lower bound pass the upper one, or every drag would
	// return the same value and the divider would not move.
	return clamp(y, Math.min(commitsShare + MIN_SHARE, hi), hi);
}

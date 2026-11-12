/**
 * Height split of the Left sidebar below its header: the Workspace list,
 * then the **Agents list** with a divider above it.
 *
 * One stored number, `agentsShare`: the Agents list's fraction of that
 * height. Collapsed, the Agents list pins its header and has no share; the
 * Workspace list takes the rest. Shares are flex-grow weights.
 */

/** Neither side is dragged below this share. */
export const MIN_AGENTS_SHARE = 0.15;

export interface LeftSidebarShares {
	workspaces: number;
	agents: number;
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

export function leftSidebarShares(opts: {
	agentsShare: number;
	agentsCollapsed: boolean;
}): LeftSidebarShares {
	if (opts.agentsCollapsed) return { workspaces: 1, agents: 0 };
	const agents = clamp(
		Number.isFinite(opts.agentsShare) ? opts.agentsShare : 0.3,
		MIN_AGENTS_SHARE,
		1 - MIN_AGENTS_SHARE,
	);
	return { workspaces: 1 - agents, agents };
}

/** Dragging the divider to height fraction `y` (0 = top of the split, 1 =
 *  bottom): the Workspace list ends at `y`, the Agents list fills the rest. */
export function agentsShareFromDrag(y: number): number {
	return clamp(1 - y, MIN_AGENTS_SHARE, 1 - MIN_AGENTS_SHARE);
}

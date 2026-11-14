// Opening a Workspace starts every Watched Agent its layout remembers, in
// every Tab, not only the Tabs that are shown (GLOSSARY: Opened workspace).
// A pane's PTY normally starts when its terminal is first shown, at the size
// it is shown at; a pane in a Tab nobody has shown has no size yet. These
// pure helpers pick the panes to start and work out a size for each from its
// Tab's split ratios and a terminal that is on screen.

import type { CodingAgent, PaneNode } from "./types";

/** A pane's share of its Tab's area: width and height, each 0–1. */
export interface PaneShare {
	w: number;
	h: number;
}

export interface GridSize {
	cols: number;
	rows: number;
}

/** The smallest size a hidden start uses, so an Agent never draws in a sliver. */
export const MIN_HIDDEN_COLS = 20;
export const MIN_HIDDEN_ROWS = 5;

/**
 * `paneId`'s share of its Tab's area, from the split ratios on the way down.
 * A `vertical` split puts its halves side by side (it divides the width); a
 * `horizontal` one stacks them (it divides the height). Null when the pane
 * is not in the layout.
 */
export function paneShare(layout: PaneNode, paneId: string): PaneShare | null {
	if (layout.type === "split") {
		const ratio = Math.min(Math.max(layout.ratio, 0), 1);
		for (const [child, part] of [
			[layout.first, ratio],
			[layout.second, 1 - ratio],
		] as const) {
			const inner = paneShare(child, paneId);
			if (!inner) continue;
			return layout.direction === "vertical"
				? { w: inner.w * part, h: inner.h }
				: { w: inner.w, h: inner.h * part };
		}
		return null;
	}
	return layout.id === paneId ? { w: 1, h: 1 } : null;
}

/**
 * The grid for a hidden pane: scale a shown terminal's grid up to the whole
 * Tab area (dividing by its share), then down to the hidden pane's share.
 * Title bars and dividers are ignored, so it is close rather than exact;
 * the PTY is resized as usual when the pane is first shown.
 */
export function hiddenPaneSize(
	reference: GridSize & { share: PaneShare },
	share: PaneShare,
): GridSize | null {
	const { cols, rows } = reference;
	const ref = reference.share;
	if (cols <= 0 || rows <= 0 || ref.w <= 0 || ref.h <= 0) return null;
	return {
		cols: Math.max(MIN_HIDDEN_COLS, Math.floor((cols / ref.w) * share.w)),
		rows: Math.max(MIN_HIDDEN_ROWS, Math.floor((rows / ref.h) * share.h)),
	};
}

/**
 * True when the Agent a pane remembers is **Watched**, so it should start
 * even while its Tab is hidden. An Agent that is switched off, or no longer
 * known, waits until its Tab is shown.
 */
export function isWatchedAgent(
	agents: CodingAgent[],
	agentId: string | undefined,
): boolean {
	if (!agentId) return false;
	const agent = agents.find((a) => a.id === agentId);
	return !!agent && agent.enabled;
}

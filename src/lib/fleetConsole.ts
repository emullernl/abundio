/**
 * Pure helpers for the **Fleet Console** (see CONTEXT.md and ADR-0040):
 * which panes become **Fleet tiles**, in what order, and how the grid is
 * shaped. No stores, no DOM — the component feeds these from the stores.
 */

import type { PtyActivityEntry } from "../stores/ptyActivityStore";
import { collectTerminals, parseTabLayout } from "./paneTree";
import type { WorkspaceWithTabs } from "./types";

export interface FleetTile {
	paneId: string;
	ptyId: string;
	workspaceId: string;
	tabId: string;
	tabName: string;
}

export interface FleetTilesInput {
	workspaces: WorkspaceWithTabs[];
	/** Workspace ids in Left sidebar order (`flattenRowsToIds(buildWorkspaceRows(...))`). */
	sidebarOrder: string[];
	openedWorkspaceIds: ReadonlySet<string>;
	activities: Record<string, PtyActivityEntry | undefined>;
	panePtyMap: Record<string, string>;
	/** Panes shown whatever their mode: an Agent just started from the console.
	 *  Its tile must exist *before* agent mode, because the launch command is
	 *  typed only once the terminal has been drawn somewhere, and a new Tab
	 *  that is not active is drawn nowhere else. */
	alsoShow?: ReadonlySet<string>;
}

/**
 * Every agent-mode PTY in the Opened workspaces, in **derived order**: Left
 * sidebar Workspace order, then Tab order, then depth-first pane order. A
 * Workspace missing from `sidebarOrder` (not yet grouped) goes last, in list
 * order, rather than vanishing.
 */
export function fleetTiles(input: FleetTilesInput): FleetTile[] {
	const byId = new Map(input.workspaces.map((w) => [w.id, w]));
	const ordered: WorkspaceWithTabs[] = [];
	const seen = new Set<string>();
	for (const id of input.sidebarOrder) {
		const ws = byId.get(id);
		if (ws && !seen.has(id)) {
			ordered.push(ws);
			seen.add(id);
		}
	}
	for (const ws of input.workspaces) {
		if (!seen.has(ws.id)) ordered.push(ws);
	}

	const tiles: FleetTile[] = [];
	for (const ws of ordered) {
		if (!input.openedWorkspaceIds.has(ws.id)) continue;
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			for (const t of collectTerminals(layout)) {
				// The live ptyId, not the layout's: panePtyMap is written at spawn,
				// ahead of the layout write-back (ADR-0020).
				const ptyId = input.panePtyMap[t.id] ?? t.ptyId;
				const forced = input.alsoShow?.has(t.id) ?? false;
				if (!forced) {
					if (!ptyId) continue;
					if (input.activities[ptyId]?.detectionMode !== "agent") continue;
				}
				tiles.push({
					paneId: t.id,
					ptyId,
					workspaceId: ws.id,
					tabId: tab.id,
					tabName: tab.name,
				});
			}
		}
	}
	return tiles;
}

export const MAX_COLUMNS = 8;
export const MAX_VISIBLE_ROWS = 4;

/** A terminal reads best somewhat wider than tall. */
const PREFERRED_ASPECT = 1.6;

/**
 * The column count **Auto** picks for `count` tiles (plus the New agent tile)
 * in a `width` × `height` area: the one whose cells come closest to a
 * comfortable terminal shape.
 */
export function autoColumns(
	count: number,
	width: number,
	height: number,
): number {
	const cells = count + 1;
	if (width <= 0 || height <= 0) return 1;
	let best = 1;
	let bestScore = -1;
	for (let c = 1; c <= Math.min(MAX_COLUMNS, cells); c++) {
		// Scored as if every row were on screen, so a choice that would scroll
		// loses to one that fits. The on-screen cap applies afterwards.
		const rows = Math.ceil(cells / c);
		const w = width / c;
		const h = height / rows;
		// The largest PREFERRED_ASPECT box that fits in the cell.
		const score = Math.min(w / PREFERRED_ASPECT, h);
		if (score > bestScore + 1e-9) {
			best = c;
			bestScore = score;
		}
	}
	return best;
}

/** Visible rows **Auto** uses with `columns` columns. */
export function autoVisibleRows(count: number, columns: number): number {
	return Math.max(
		1,
		Math.min(MAX_VISIBLE_ROWS, Math.ceil((count + 1) / columns)),
	);
}

export interface GridShape {
	/** Rows that exist; beyond `visibleRows` the grid scrolls. */
	totalRows: number;
	/** Cells after the tiles: the first is the New agent tile, the rest blank. */
	freeCells: number;
}

/**
 * The grid for `count` tiles. There is always at least one free cell, so the
 * New agent tile is always reachable, and the grid is never smaller than the
 * chosen `columns × visibleRows`.
 */
export function gridShape(
	count: number,
	columns: number,
	visibleRows: number,
): GridShape {
	const cols = Math.max(1, columns);
	const totalRows = Math.max(visibleRows, Math.ceil((count + 1) / cols));
	return { totalRows, freeCells: totalRows * cols - count };
}

/**
 * Normalise stored ratios to `n` positive fractions summing to 1. Stored
 * ratios of the wrong length (the preset changed) fall back to equal sizes.
 */
export function normalizeRatios(
	ratios: readonly number[] | undefined,
	n: number,
): number[] {
	if (!ratios || ratios.length !== n || ratios.some((r) => !(r > 0))) {
		return Array.from({ length: n }, () => 1 / n);
	}
	const sum = ratios.reduce((a, b) => a + b, 0);
	return ratios.map((r) => r / sum);
}

/** Smallest share a column or row may be dragged down to. */
export const MIN_RATIO = 0.1;

/**
 * Move the divider between track `index` and `index + 1` by `delta` (a
 * fraction of the whole), keeping both tracks at least `MIN_RATIO`.
 */
export function dragDivider(
	ratios: readonly number[],
	index: number,
	delta: number,
): number[] {
	const next = [...ratios];
	const pair = next[index] + next[index + 1];
	const a = Math.min(
		pair - MIN_RATIO,
		Math.max(MIN_RATIO, next[index] + delta),
	);
	next[index] = a;
	next[index + 1] = pair - a;
	return next;
}

export type GridDirection = "up" | "down" | "left" | "right";

/**
 * The tile a **Directional move** lands on from tile `index`, in a grid of
 * `count` tiles laid out `columns` wide, or `null` at an edge (no wrap).
 * Moving down into a short last row lands on its last tile.
 */
export function gridNeighbour(
	index: number,
	count: number,
	columns: number,
	dir: GridDirection,
): number | null {
	if (count === 0 || index < 0 || index >= count) return null;
	const col = index % columns;
	switch (dir) {
		case "left":
			return col === 0 ? null : index - 1;
		case "right":
			return col === columns - 1 || index + 1 >= count ? null : index + 1;
		case "up":
			return index - columns >= 0 ? index - columns : null;
		case "down": {
			const below = index + columns;
			if (below < count) return below;
			const lastRowStart = Math.floor((count - 1) / columns) * columns;
			return index < lastRowStart ? count - 1 : null;
		}
	}
}

/** **Pane cycle** over tiles: reading order, wrapping. */
export function cycleTile(
	tiles: readonly { paneId: string }[],
	fromPaneId: string | null,
	step: 1 | -1,
): string | null {
	if (tiles.length === 0) return null;
	const i = tiles.findIndex((t) => t.paneId === fromPaneId);
	if (i < 0) return tiles[step === 1 ? 0 : tiles.length - 1].paneId;
	return tiles[(i + step + tiles.length) % tiles.length].paneId;
}

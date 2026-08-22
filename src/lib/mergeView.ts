/**
 * The Merge view: read-only side panes showing a conflicted file's index stages,
 * arranged above the editable result pane.
 *
 * Composed from Abundio's own pane tree rather than a merge-editor widget —
 * monaco's standalone distribution ships none, and the expensive half of one
 * (computing the merged result) is already done by git, whose conflicted working
 * file *is* that result. See ADR-0030.
 *
 * Modelled directly on `markdownPreview.ts`, which solves the same problem for
 * a different derived pane.
 */

import { useWorkspaceStore } from "../stores/workspaceStore";
import {
	findAllDerivedForSource,
	findDerivedForSource,
	findNode,
	removeNode,
	replaceNode,
} from "./paneTree";
import type { PaneNode } from "./types";

export type MergeSide = "current" | "incoming" | "base";

function makeMergeSideNode(sourcePaneId: string, side: MergeSide): PaneNode {
	return { type: "mergeSide", id: crypto.randomUUID(), sourcePaneId, side };
}

/** Side panes above, result below — mirroring VS Code's arrangement.
 *
 *  Note the direction naming: a "vertical" split lays its children out in a row
 *  (see `SplitNode`), so side-by-side is "vertical" and stacked is "horizontal". */
function buildMergeLayout(
	fileNode: PaneNode,
	sourcePaneId: string,
	withBase: boolean,
): PaneNode {
	const current = makeMergeSideNode(sourcePaneId, "current");
	const incoming = makeMergeSideNode(sourcePaneId, "incoming");

	const sides: PaneNode = withBase
		? {
				type: "split",
				id: crypto.randomUUID(),
				direction: "vertical",
				ratio: 1 / 3,
				first: current,
				// The ancestor sits between the two divergences.
				second: {
					type: "split",
					id: crypto.randomUUID(),
					direction: "vertical",
					ratio: 0.5,
					first: makeMergeSideNode(sourcePaneId, "base"),
					second: incoming,
				},
			}
		: {
				type: "split",
				id: crypto.randomUUID(),
				direction: "vertical",
				ratio: 0.5,
				first: current,
				second: incoming,
			};

	return {
		type: "split",
		id: crypto.randomUUID(),
		direction: "horizontal",
		ratio: 0.45,
		first: sides,
		second: fileNode,
	};
}

/** Resolve a side pane back to its source, so the toggle works from either. */
function sourceOf(layout: PaneNode, paneId: string): string | null {
	const node = findNode(layout, paneId);
	if (!node) return null;
	if (node.type === "mergeSide") return node.sourcePaneId;
	if (node.type === "file") return paneId;
	return null;
}

function removeSidesFor(
	layout: PaneNode,
	sourcePaneId: string,
): PaneNode | null {
	let result: PaneNode | null = layout;
	for (const node of findAllDerivedForSource(layout, sourcePaneId)) {
		if (!result) break;
		if (node.type !== "mergeSide") continue;
		result = removeNode(result, node.id);
	}
	return result;
}

export function hasMergeView(layout: PaneNode, sourcePaneId: string): boolean {
	return findDerivedForSource(layout, sourcePaneId, "mergeSide") !== null;
}

/** Open or close the Merge view for a file pane (or for one of its side panes). */
export async function toggleMergeViewForPane(paneId: string): Promise<void> {
	const ws = useWorkspaceStore.getState();
	const tab = ws.getActiveTab();
	const layout = ws.getActiveLayout();
	if (!tab || !layout) return;

	const sourcePaneId = sourceOf(layout, paneId);
	if (!sourcePaneId) return;

	if (hasMergeView(layout, sourcePaneId)) {
		const next = removeSidesFor(layout, sourcePaneId);
		if (next) await ws.updateLayout(tab.id, next);
		return;
	}

	const fileNode = findNode(layout, sourcePaneId);
	if (fileNode?.type !== "file") return;
	const next = replaceNode(
		layout,
		sourcePaneId,
		buildMergeLayout(fileNode, sourcePaneId, false),
	);
	await ws.updateLayout(tab.id, next);
}

/** Show or hide the ancestor pane. No-op when the conflict has no stage 1. */
export async function toggleMergeBase(paneId: string): Promise<void> {
	const ws = useWorkspaceStore.getState();
	const tab = ws.getActiveTab();
	const layout = ws.getActiveLayout();
	if (!tab || !layout) return;

	const sourcePaneId = sourceOf(layout, paneId);
	if (!sourcePaneId) return;

	const existingBase = findAllDerivedForSource(layout, sourcePaneId).find(
		(n) => n.type === "mergeSide" && n.side === "base",
	);

	if (existingBase) {
		const next = removeNode(layout, existingBase.id);
		if (next) await ws.updateLayout(tab.id, next);
		return;
	}

	// Rebuild rather than splice: the three-pane ratios are only sane when laid
	// out together.
	const stripped = removeSidesFor(layout, sourcePaneId);
	if (!stripped) return;
	const fileNode = findNode(stripped, sourcePaneId);
	if (fileNode?.type !== "file") return;
	const next = replaceNode(
		stripped,
		sourcePaneId,
		buildMergeLayout(fileNode, sourcePaneId, true),
	);
	await ws.updateLayout(tab.id, next);
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateLayout = vi.fn((_tabId: string, _layout: unknown) =>
	Promise.resolve(),
);
let layout: PaneNode | null = null;

vi.mock("../../stores/workspaceStore", () => ({
	useWorkspaceStore: {
		getState: () => ({
			getActiveTab: () => ({ id: "tab-1" }),
			getActiveLayout: () => layout,
			updateLayout,
		}),
	},
}));

import {
	hasMergeView,
	pruneResolvedMergeSides,
	toggleMergeBase,
	toggleMergeViewForPane,
} from "../mergeView";
import { collectPaneIds, findNode } from "../paneTree";
import type { PaneNode } from "../types";

const fileNode = (id: string, filePath: string): PaneNode => ({
	type: "file",
	id,
	filePath,
});

function sidesOf(tree: PaneNode) {
	return collectPaneIds(tree)
		.map((id) => findNode(tree, id))
		.filter(
			(n): n is PaneNode & { type: "mergeSide" } => n?.type === "mergeSide",
		);
}

beforeEach(() => {
	updateLayout.mockClear();
	layout = fileNode("pane-1", "/repo/a.txt");
});

describe("toggleMergeViewForPane", () => {
	it("opens Current and Incoming above the result pane", async () => {
		await toggleMergeViewForPane("pane-1");
		const next = updateLayout.mock.calls[0][1] as unknown as PaneNode;

		const sides = sidesOf(next);
		expect(sides.map((s) => s.side)).toEqual(["current", "incoming"]);
		expect(sides.every((s) => s.sourcePaneId === "pane-1")).toBe(true);

		// Stacked: sides on top, the editable result below.
		expect(next.type).toBe("split");
		if (next.type !== "split") throw new Error("expected a split");
		expect(next.direction).toBe("horizontal");
		expect(next.second).toEqual(fileNode("pane-1", "/repo/a.txt"));
	});

	it("closes an open merge view", async () => {
		await toggleMergeViewForPane("pane-1");
		layout = updateLayout.mock.calls[0][1] as unknown as PaneNode;
		expect(hasMergeView(layout, "pane-1")).toBe(true);

		await toggleMergeViewForPane("pane-1");
		const closed = updateLayout.mock.calls[1][1] as unknown as PaneNode;
		expect(sidesOf(closed)).toHaveLength(0);
		expect(closed).toEqual(fileNode("pane-1", "/repo/a.txt"));
	});

	it("resolves to the source when invoked from a side pane", async () => {
		await toggleMergeViewForPane("pane-1");
		layout = updateLayout.mock.calls[0][1] as unknown as PaneNode;
		const sidePaneId = sidesOf(layout)[0].id;

		await toggleMergeViewForPane(sidePaneId);
		const closed = updateLayout.mock.calls[1][1] as unknown as PaneNode;
		expect(sidesOf(closed)).toHaveLength(0);
	});

	it("does nothing for a pane that is not in the layout", async () => {
		await toggleMergeViewForPane("nope");
		expect(updateLayout).not.toHaveBeenCalled();
	});
});

describe("toggleMergeBase", () => {
	it("adds the ancestor pane between the two sides", async () => {
		await toggleMergeViewForPane("pane-1");
		layout = updateLayout.mock.calls[0][1] as unknown as PaneNode;

		await toggleMergeBase("pane-1");
		const withBase = updateLayout.mock.calls[1][1] as unknown as PaneNode;
		expect(sidesOf(withBase).map((s) => s.side)).toEqual([
			"current",
			"base",
			"incoming",
		]);
	});

	it("removes the ancestor pane again", async () => {
		await toggleMergeViewForPane("pane-1");
		layout = updateLayout.mock.calls[0][1] as unknown as PaneNode;
		await toggleMergeBase("pane-1");
		layout = updateLayout.mock.calls[1][1] as unknown as PaneNode;

		await toggleMergeBase("pane-1");
		const withoutBase = updateLayout.mock.calls[2][1] as unknown as PaneNode;
		expect(sidesOf(withoutBase).map((s) => s.side)).toEqual([
			"current",
			"incoming",
		]);
	});
});

describe("pruneResolvedMergeSides", () => {
	it("drops the sides once the source is no longer conflicted", async () => {
		await toggleMergeViewForPane("pane-1");
		const open = updateLayout.mock.calls[0][1] as unknown as PaneNode;

		const pruned = pruneResolvedMergeSides(open, () => false);
		expect(sidesOf(pruned)).toHaveLength(0);
		expect(pruned).toEqual(fileNode("pane-1", "/repo/a.txt"));
	});

	it("keeps the sides while the source is still conflicted", async () => {
		await toggleMergeViewForPane("pane-1");
		const open = updateLayout.mock.calls[0][1] as unknown as PaneNode;

		expect(pruneResolvedMergeSides(open, () => true)).toBe(open);
	});

	it("is a no-op on a tree with no merge sides", () => {
		const plain = fileNode("pane-1", "/repo/a.txt");
		expect(pruneResolvedMergeSides(plain, () => false)).toBe(plain);
	});
});

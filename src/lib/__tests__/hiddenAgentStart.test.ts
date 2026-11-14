import { describe, expect, it } from "vitest";
import {
	hiddenPaneSize,
	isWatchedAgent,
	MIN_HIDDEN_COLS,
	MIN_HIDDEN_ROWS,
	outsideWorkspaceView,
	paneShare,
	sizeForHiddenPane,
} from "../hiddenAgentStart";
import type { CodingAgent, PaneNode } from "../types";

const leaf = (id: string): PaneNode => ({ type: "terminal", id, ptyId: "" });

describe("paneShare", () => {
	it("is the whole Tab for a single pane", () => {
		expect(paneShare(leaf("a"), "a")).toEqual({ w: 1, h: 1 });
	});

	it("divides the width for a vertical split and the height for a horizontal one", () => {
		const layout: PaneNode = {
			type: "split",
			id: "s1",
			direction: "vertical",
			ratio: 0.25,
			first: leaf("left"),
			second: {
				type: "split",
				id: "s2",
				direction: "horizontal",
				ratio: 0.5,
				first: leaf("top"),
				second: leaf("bottom"),
			},
		};
		expect(paneShare(layout, "left")).toEqual({ w: 0.25, h: 1 });
		expect(paneShare(layout, "bottom")).toEqual({ w: 0.75, h: 0.5 });
	});

	it("is null for a pane not in the layout", () => {
		expect(paneShare(leaf("a"), "b")).toBeNull();
	});
});

describe("hiddenPaneSize", () => {
	it("scales a shown pane's grid to the hidden pane's share", () => {
		// Shown: the left half of its Tab, 100×40. Hidden: a whole Tab.
		expect(
			hiddenPaneSize(
				{ cols: 100, rows: 40, share: { w: 0.5, h: 1 } },
				{ w: 1, h: 1 },
			),
		).toEqual({ cols: 200, rows: 40 });
	});

	it("never goes below the minimum", () => {
		expect(
			hiddenPaneSize(
				{ cols: 80, rows: 24, share: { w: 1, h: 1 } },
				{ w: 0.05, h: 0.05 },
			),
		).toEqual({ cols: MIN_HIDDEN_COLS, rows: MIN_HIDDEN_ROWS });
	});

	it("is null for an unmeasured reference", () => {
		expect(
			hiddenPaneSize(
				{ cols: 0, rows: 0, share: { w: 1, h: 1 } },
				{ w: 1, h: 1 },
			),
		).toBeNull();
	});
});

describe("isWatchedAgent", () => {
	const agents = [
		{ id: "claude", enabled: true },
		{ id: "codex", enabled: false },
	] as CodingAgent[];

	it("is true only for a known, switched-on Agent", () => {
		expect(isWatchedAgent(agents, "claude")).toBe(true);
		expect(isWatchedAgent(agents, "codex")).toBe(false);
		expect(isWatchedAgent(agents, "gone")).toBe(false);
		expect(isWatchedAgent(agents, undefined)).toBe(false);
	});
});

describe("sizeForHiddenPane", () => {
	const split = (a: string, b: string): PaneNode => ({
		type: "split",
		id: `${a}-${b}`,
		direction: "vertical",
		ratio: 0.5,
		first: leaf(a),
		second: leaf(b),
	});
	const workspaces = [
		{
			tabs: [
				{ layoutJson: JSON.stringify(split("left", "right")) },
				{ layoutJson: JSON.stringify(leaf("full")) },
				{ layoutJson: JSON.stringify(leaf("hidden")) },
			],
		},
	];
	const grids: Record<string, { cols: number; rows: number }> = {
		// Half the Tab's width: the whole Tab is 200 columns.
		left: { cols: 100, rows: 40 },
		// The whole Tab, but a different (smaller) Window area: 150 columns.
		full: { cols: 150, rows: 30 },
	};
	const shown = (id: string) => grids[id] ?? null;

	it("measures against the first shown terminal", () => {
		expect(sizeForHiddenPane("hidden", workspaces, null, shown)).toEqual({
			cols: 200,
			rows: 40,
		});
	});

	it("prefers the Focused pane when it is shown", () => {
		expect(sizeForHiddenPane("hidden", workspaces, "full", shown)).toEqual({
			cols: 150,
			rows: 30,
		});
	});

	it("falls back when the Focused pane is not shown", () => {
		expect(sizeForHiddenPane("hidden", workspaces, "right", shown)).toEqual({
			cols: 200,
			rows: 40,
		});
	});

	it("is null when nothing is shown", () => {
		expect(
			sizeForHiddenPane("hidden", workspaces, null, () => null),
		).toBeNull();
	});

	it("is null for a pane in no layout", () => {
		expect(sizeForHiddenPane("gone", workspaces, null, shown)).toBeNull();
	});
});

describe("outsideWorkspaceView", () => {
	const inside = (attr: string | null) => {
		const outer = document.createElement("div");
		if (attr) outer.setAttribute(attr, "");
		const el = document.createElement("div");
		outer.appendChild(el);
		return el;
	};

	it("is true in the TerminalPool and in a Fleet tile", () => {
		expect(outsideWorkspaceView(inside("data-terminal-pool"))).toBe(true);
		expect(outsideWorkspaceView(inside("data-fleet-tile"))).toBe(true);
	});

	it("is false in a Workspace view slot", () => {
		expect(outsideWorkspaceView(inside(null))).toBe(false);
	});
});

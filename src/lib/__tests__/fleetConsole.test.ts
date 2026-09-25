import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import {
	autoColumns,
	autoVisibleRows,
	cycleTile,
	dragDivider,
	fleetTiles,
	gridNeighbour,
	gridShape,
	MIN_RATIO,
	normalizeRatios,
} from "../fleetConsole";
import type { PaneNode, WorkspaceWithTabs } from "../types";

function term(id: string, ptyId = ""): PaneNode {
	return { type: "terminal", id, ptyId } as PaneNode;
}
function split(first: PaneNode, second: PaneNode): PaneNode {
	return {
		type: "split",
		id: `s-${Math.random()}`,
		direction: "horizontal",
		ratio: 0.5,
		first,
		second,
	} as PaneNode;
}
function ws(id: string, tabs: [string, PaneNode][]): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		tabs: tabs.map(([tabId, layout], position) => ({
			id: tabId,
			workspaceId: id,
			name: `Tab ${tabId}`,
			layoutJson: JSON.stringify(layout),
			position,
			createdAt: 0,
			updatedAt: 0,
		})),
	} as unknown as WorkspaceWithTabs;
}
function act(mode: "agent" | "shell"): PtyActivityEntry {
	return { detectionMode: mode } as PtyActivityEntry;
}

describe("fleetTiles", () => {
	const a = ws("a", [
		["a1", split(term("pa1", "x1"), term("pa2", "x2"))],
		["a2", term("pa3", "x3")],
	]);
	const b = ws("b", [["b1", term("pb1", "y1")]]);
	const activities = {
		x1: act("agent"),
		x2: act("shell"),
		x3: act("agent"),
		y1: act("agent"),
	};

	it("keeps agent-mode panes only, in sidebar → tab → pane order", () => {
		const tiles = fleetTiles({
			workspaces: [a, b],
			sidebarOrder: ["b", "a"],
			openedWorkspaceIds: new Set(["a", "b"]),
			activities,
			panePtyMap: {},
		});
		expect(tiles.map((t) => t.paneId)).toEqual(["pb1", "pa1", "pa3"]);
		expect(tiles[1]).toMatchObject({ workspaceId: "a", tabId: "a1" });
	});

	it("skips Workspaces that are not Opened", () => {
		const tiles = fleetTiles({
			workspaces: [a, b],
			sidebarOrder: ["a", "b"],
			openedWorkspaceIds: new Set(["b"]),
			activities,
			panePtyMap: {},
		});
		expect(tiles.map((t) => t.paneId)).toEqual(["pb1"]);
	});

	it("reads the live ptyId from panePtyMap before the layout's", () => {
		const fresh = ws("c", [["c1", term("pc1", "")]]);
		const tiles = fleetTiles({
			workspaces: [fresh],
			sidebarOrder: ["c"],
			openedWorkspaceIds: new Set(["c"]),
			activities: { z9: act("agent") },
			panePtyMap: { pc1: "z9" },
		});
		expect(tiles).toEqual([
			{
				paneId: "pc1",
				ptyId: "z9",
				workspaceId: "c",
				tabId: "c1",
				tabName: "Tab c1",
			},
		]);
	});

	it("an Agent exiting (back to shell mode) removes its tile", () => {
		const tiles = fleetTiles({
			workspaces: [b],
			sidebarOrder: ["b"],
			openedWorkspaceIds: new Set(["b"]),
			activities: { y1: act("shell") },
			panePtyMap: {},
		});
		expect(tiles).toEqual([]);
	});

	it("shows a just-started pane before it reaches agent mode", () => {
		const fresh = ws("c", [["c1", term("pc1", "")]]);
		const tiles = fleetTiles({
			workspaces: [fresh],
			sidebarOrder: ["c"],
			openedWorkspaceIds: new Set(["c"]),
			activities: {},
			panePtyMap: {},
			alsoShow: new Set(["pc1"]),
		});
		expect(tiles.map((t) => t.paneId)).toEqual(["pc1"]);
	});

	it("a Workspace missing from the sidebar order still appears, last", () => {
		const tiles = fleetTiles({
			workspaces: [a, b],
			sidebarOrder: ["b"],
			openedWorkspaceIds: new Set(["a", "b"]),
			activities,
			panePtyMap: {},
		});
		expect(tiles.map((t) => t.paneId)).toEqual(["pb1", "pa1", "pa3"]);
	});
});

describe("grid shape", () => {
	it("always leaves a free cell for Add agent", () => {
		expect(gridShape(6, 3, 2)).toEqual({ totalRows: 3, freeCells: 3 });
		expect(gridShape(5, 3, 2)).toEqual({ totalRows: 2, freeCells: 1 });
		expect(gridShape(0, 2, 2)).toEqual({ totalRows: 2, freeCells: 4 });
	});

	it("grows rows beyond the visible count instead of hiding tiles", () => {
		expect(gridShape(8, 3, 2).totalRows).toBe(3);
	});

	it("auto picks few columns for few tiles and more for many", () => {
		expect(autoColumns(0, 1600, 900)).toBe(1);
		expect(autoColumns(3, 1600, 900)).toBe(2);
		expect(autoColumns(11, 1600, 900)).toBe(4);
		expect(autoColumns(3, 0, 0)).toBe(1);
	});

	it("auto visible rows cap at four", () => {
		expect(autoVisibleRows(0, 1)).toBe(1);
		expect(autoVisibleRows(3, 2)).toBe(2);
		expect(autoVisibleRows(20, 4)).toBe(4);
	});

	// A wide screen should be able to use it: up to 8 columns.
	it("auto uses more columns on a very wide screen", () => {
		expect(autoColumns(11, 3440, 900)).toBeGreaterThan(4);
		expect(autoColumns(40, 3440, 1300)).toBeLessThanOrEqual(8);
	});
});

describe("ratios", () => {
	it("falls back to equal shares when the stored length is wrong", () => {
		expect(normalizeRatios([0.5, 0.5], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(normalizeRatios(undefined, 2)).toEqual([0.5, 0.5]);
	});

	it("normalises stored ratios to sum to 1", () => {
		expect(normalizeRatios([1, 3], 2)).toEqual([0.25, 0.75]);
	});

	it("dragging a divider keeps both sides above the minimum", () => {
		const r = dragDivider([0.5, 0.5], 0, 0.6);
		expect(r[1]).toBeCloseTo(MIN_RATIO);
		expect(r[0] + r[1]).toBeCloseTo(1);
		expect(dragDivider([0.25, 0.25, 0.5], 1, 0.1)).toEqual([0.25, 0.35, 0.4]);
	});
});

describe("grid navigation", () => {
	// 3 columns, 7 tiles:
	// 0 1 2
	// 3 4 5
	// 6
	it("moves by geometry without wrapping", () => {
		expect(gridNeighbour(4, 7, 3, "left")).toBe(3);
		expect(gridNeighbour(3, 7, 3, "left")).toBeNull();
		expect(gridNeighbour(2, 7, 3, "right")).toBeNull();
		expect(gridNeighbour(1, 7, 3, "up")).toBeNull();
		expect(gridNeighbour(4, 7, 3, "up")).toBe(1);
		expect(gridNeighbour(3, 7, 3, "down")).toBe(6);
		expect(gridNeighbour(6, 7, 3, "right")).toBeNull();
	});

	it("down into a short last row lands on its last tile", () => {
		expect(gridNeighbour(5, 7, 3, "down")).toBe(6);
		expect(gridNeighbour(6, 7, 3, "down")).toBeNull();
	});

	it("cycles in reading order and wraps", () => {
		const tiles = [{ paneId: "a" }, { paneId: "b" }, { paneId: "c" }];
		expect(cycleTile(tiles, "c", 1)).toBe("a");
		expect(cycleTile(tiles, "a", -1)).toBe("c");
		expect(cycleTile(tiles, null, 1)).toBe("a");
		expect(cycleTile([], null, 1)).toBeNull();
	});
});

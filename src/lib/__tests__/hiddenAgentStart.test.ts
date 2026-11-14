import { describe, expect, it } from "vitest";
import {
	hiddenPaneSize,
	isWatchedAgent,
	MIN_HIDDEN_COLS,
	MIN_HIDDEN_ROWS,
	paneShare,
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

import { describe, expect, it } from "vitest";
import {
	cyclePane,
	neighbourInDirection,
	type PaneDirection,
	paneRects,
} from "../paneTree";
import type { PaneNode } from "../types";

const t = (id: string): PaneNode => ({ type: "terminal", id, ptyId: "" });
const f = (id: string): PaneNode => ({ type: "file", id, filePath: `/${id}` });
const p = (id: string, sourcePaneId: string): PaneNode => ({
	type: "preview",
	id,
	sourcePaneId,
});
/** Side by side (a `vertical` split lays children out in a row). */
const row = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
	type: "split",
	id: `row-${first.id}-${second.id}`,
	direction: "vertical",
	ratio,
	first,
	second,
});
/** Stacked. */
const col = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
	type: "split",
	id: `col-${first.id}-${second.id}`,
	direction: "horizontal",
	ratio,
	first,
	second,
});

describe("paneRects", () => {
	it("splits the unit square by ratio", () => {
		const rects = paneRects(row(t("a"), col(t("b"), t("c"), 0.25), 0.4));
		expect(rects.get("a")).toEqual({ x: 0, y: 0, w: 0.4, h: 1 });
		expect(rects.get("b")).toEqual({ x: 0.4, y: 0, w: 0.6, h: 0.25 });
		expect(rects.get("c")).toEqual({ x: 0.4, y: 0.25, w: 0.6, h: 0.75 });
	});

	it("gives a lone pane the whole tab", () => {
		expect(paneRects(t("a")).get("a")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});
});

describe("neighbourInDirection", () => {
	// ┌───┬───┐
	// │ a │ b │
	// │   ├───┤
	// │   │ c │
	// └───┴───┘
	const lShape = row(t("a"), col(t("b"), t("c")));

	// ┌───┬───┐
	// │   │ b │
	// │   ├───┤
	// │ a │ c │   a's centre line runs through c
	// │   ├───┤
	// │   │ d │
	// └───┴───┘
	const threeColumn = row(t("a"), col(t("b"), col(t("c"), t("d"))), 0.5);

	// ┌───┬───┐
	// │ a │ b │
	// ├───┼───┤   two independent columns — ↓ from b must stay in column 2,
	// │ c │ d │   which the old tree-order "arrow" did not
	// └───┴───┘
	const grid = row(col(t("a"), t("c")), col(t("b"), t("d")));

	// biome-ignore format: one row per case reads as a table
	const cases: [string, PaneNode, string, PaneDirection, string | null][] = [
		["L: right from a lands on the pane across its centre", lShape, "a", "right", "c"],
		["L: left from b reaches a", lShape, "b", "left", "a"],
		["L: left from c reaches a", lShape, "c", "left", "a"],
		["L: down from b reaches c", lShape, "b", "down", "c"],
		["L: up from c reaches b", lShape, "c", "up", "b"],
		["L: no wrap at the left edge", lShape, "a", "left", null],
		["L: no wrap at the bottom edge", lShape, "c", "down", null],
		["L: no wrap at the right edge", lShape, "b", "right", null],
		["3-col: centre line picks the middle pane", threeColumn, "a", "right", "c"],
		["3-col: every stacked pane goes left to a", threeColumn, "d", "left", "a"],
		["3-col: down walks the stack", threeColumn, "c", "down", "d"],
		["grid: down from b stays in its column", grid, "b", "down", "d"],
		["grid: right from c crosses to d", grid, "c", "right", "d"],
		["grid: up from d reaches b", grid, "d", "up", "b"],
		["grid: left from b reaches a", grid, "b", "left", "a"],
	];

	it.each(cases)("%s", (_name, tree, from, dir, expected) => {
		expect(neighbourInDirection(tree, from, dir)).toBe(expected);
	});

	it("reaches file and preview panes, not just terminals", () => {
		const tree = row(t("term"), row(f("file"), p("prev", "file")));
		expect(neighbourInDirection(tree, "term", "right")).toBe("file");
		expect(neighbourInDirection(tree, "file", "right")).toBe("prev");
		expect(neighbourInDirection(tree, "prev", "left")).toBe("file");
	});

	it("uses the ratio, not the tree shape, to decide the centre line", () => {
		// b is tall (80%): a's centre line (y = 0.5) runs through b, not c.
		const tree = row(t("a"), col(t("b"), t("c"), 0.8));
		expect(neighbourInDirection(tree, "a", "right")).toBe("b");
	});

	it("returns null for a pane that is not in the tree", () => {
		expect(neighbourInDirection(lShape, "nope", "right")).toBeNull();
	});
});

describe("cyclePane", () => {
	const tree = row(t("a"), col(f("b"), p("c", "b")));

	it("walks every pane type in tree order", () => {
		expect(cyclePane(tree, "a", 1)).toBe("b");
		expect(cyclePane(tree, "b", 1)).toBe("c");
	});

	it("wraps at both ends", () => {
		expect(cyclePane(tree, "c", 1)).toBe("a");
		expect(cyclePane(tree, "a", -1)).toBe("c");
	});

	it("lands on the first pane when nothing (or a stale id) is focused", () => {
		expect(cyclePane(tree, null, -1)).toBe("a");
		expect(cyclePane(tree, "gone", 1)).toBe("a");
	});

	it("has nowhere to go with a single pane", () => {
		expect(cyclePane(t("a"), "a", 1)).toBeNull();
	});
});

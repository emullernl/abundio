import { describe, expect, it } from "vitest";
import {
	collectPaneIds,
	collectTerminals,
	findNode,
	removeNode,
	replaceNode,
} from "../paneTree";
import type { PaneNode } from "../types";

const leafA: PaneNode = { type: "terminal", id: "a", ptyId: "pty-a" };
const leafB: PaneNode = { type: "terminal", id: "b", ptyId: "pty-b" };
const leafC: PaneNode = { type: "terminal", id: "c", ptyId: "pty-c" };

const simpleSplit: PaneNode = {
	type: "split",
	id: "s1",
	direction: "horizontal",
	ratio: 0.5,
	first: leafA,
	second: leafB,
};

const nestedSplit: PaneNode = {
	type: "split",
	id: "s2",
	direction: "vertical",
	ratio: 0.5,
	first: simpleSplit,
	second: leafC,
};

describe("findNode", () => {
	it("finds a terminal node by id", () => {
		expect(findNode(simpleSplit, "a")).toBe(leafA);
		expect(findNode(simpleSplit, "b")).toBe(leafB);
	});

	it("finds a split node by id", () => {
		expect(findNode(simpleSplit, "s1")).toBe(simpleSplit);
	});

	it("returns null for non-existent id", () => {
		expect(findNode(simpleSplit, "nonexistent")).toBeNull();
	});

	it("works in deeply nested trees", () => {
		expect(findNode(nestedSplit, "a")).toBe(leafA);
		expect(findNode(nestedSplit, "c")).toBe(leafC);
		expect(findNode(nestedSplit, "s1")).toBe(simpleSplit);
	});

	it("finds a single leaf", () => {
		expect(findNode(leafA, "a")).toBe(leafA);
		expect(findNode(leafA, "b")).toBeNull();
	});
});

describe("replaceNode", () => {
	it("replaces a leaf node", () => {
		const newLeaf: PaneNode = { type: "terminal", id: "x", ptyId: "pty-x" };
		const result = replaceNode(simpleSplit, "a", newLeaf);
		expect(result.type === "split" && result.first).toEqual(newLeaf);
	});

	it("replaces in second branch", () => {
		const newLeaf: PaneNode = { type: "terminal", id: "x", ptyId: "pty-x" };
		const result = replaceNode(simpleSplit, "b", newLeaf);
		expect(result.type === "split" && result.second).toEqual(newLeaf);
	});

	it("leaves tree unchanged for non-matching id", () => {
		const newLeaf: PaneNode = { type: "terminal", id: "x", ptyId: "pty-x" };
		const result = replaceNode(simpleSplit, "nonexistent", newLeaf);
		expect(result).toEqual(simpleSplit);
	});

	it("replaces in nested tree", () => {
		const newLeaf: PaneNode = { type: "terminal", id: "x", ptyId: "pty-x" };
		const result = replaceNode(nestedSplit, "a", newLeaf);
		expect(findNode(result, "x")).toEqual(newLeaf);
		expect(findNode(result, "a")).toBeNull();
	});
});

describe("removeNode", () => {
	it("removes a leaf from a split, returns sibling", () => {
		expect(removeNode(simpleSplit, "a")).toEqual(leafB);
	});

	it("removes the other leaf, returns sibling", () => {
		expect(removeNode(simpleSplit, "b")).toEqual(leafA);
	});

	it("returns null when removing the root terminal", () => {
		expect(removeNode(leafA, "a")).toBeNull();
	});

	it("returns tree unchanged for non-matching id", () => {
		expect(removeNode(simpleSplit, "nonexistent")).toEqual(simpleSplit);
	});

	it("removes from nested tree, parent collapses", () => {
		// Remove leafA from nestedSplit: s1 collapses to leafB
		const result = removeNode(nestedSplit, "a");
		expect(result).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after toBeNull check
		expect(findNode(result!, "a")).toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after toBeNull check
		expect(findNode(result!, "b")).toEqual(leafB);
		// biome-ignore lint/style/noNonNullAssertion: test assertion after toBeNull check
		expect(findNode(result!, "c")).toEqual(leafC);
	});
});

describe("collectTerminals", () => {
	it("returns single terminal in array", () => {
		expect(collectTerminals(leafA)).toEqual([{ id: "a", ptyId: "pty-a" }]);
	});

	it("returns both terminals from a split", () => {
		expect(collectTerminals(simpleSplit)).toEqual([
			{ id: "a", ptyId: "pty-a" },
			{ id: "b", ptyId: "pty-b" },
		]);
	});

	it("returns all terminals depth-first from nested tree", () => {
		expect(collectTerminals(nestedSplit)).toEqual([
			{ id: "a", ptyId: "pty-a" },
			{ id: "b", ptyId: "pty-b" },
			{ id: "c", ptyId: "pty-c" },
		]);
	});
});

describe("collectPaneIds", () => {
	it("returns single id for a leaf", () => {
		expect(collectPaneIds(leafA)).toEqual(["a"]);
	});

	it("returns ids from a split", () => {
		expect(collectPaneIds(simpleSplit)).toEqual(["a", "b"]);
	});

	it("returns all ids depth-first from a nested tree", () => {
		expect(collectPaneIds(nestedSplit)).toEqual(["a", "b", "c"]);
	});
});

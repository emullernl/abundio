import { describe, expect, it } from "vitest";
import {
	collectAgentPanes,
	collectFilePaneIds,
	collectPaneIds,
	collectTerminalIds,
	collectTerminals,
	extractNode,
	findNode,
	findOrphanPreviews,
	findPreviewForSource,
	insertBesideNode,
	pruneOrphanPreviews,
	removeNode,
	replaceNode,
	setAgentId,
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

describe("setAgentId", () => {
	it("stamps agentId on the matching terminal leaf", () => {
		const result = setAgentId(leafA, "a", "claude");
		expect(result).toEqual({
			type: "terminal",
			id: "a",
			ptyId: "pty-a",
			agentId: "claude",
		});
	});

	it("returns the original leaf when paneId does not match", () => {
		const result = setAgentId(leafA, "z", "claude");
		expect(result).toBe(leafA);
	});

	it("clears agentId when undefined is passed", () => {
		const stamped: PaneNode = {
			type: "terminal",
			id: "a",
			ptyId: "pty-a",
			agentId: "claude",
		};
		const result = setAgentId(stamped, "a", undefined);
		expect(result).toEqual({ type: "terminal", id: "a", ptyId: "pty-a" });
	});

	it("descends into splits and structurally shares unchanged branches", () => {
		const result = setAgentId(nestedSplit, "c", "copilot");
		expect(result).not.toBe(nestedSplit);
		const found = findNode(result, "c");
		expect(found).toMatchObject({ id: "c", agentId: "copilot" });
		// Untouched branch is shared by reference
		if (result.type === "split") {
			expect(result.first).toBe(nestedSplit.first);
		}
	});
});

describe("collectAgentPanes", () => {
	it("returns nothing for a layout with no agentIds", () => {
		expect(collectAgentPanes(nestedSplit)).toEqual([]);
	});

	it("collects all panes that carry an agentId", () => {
		const stamped = setAgentId(
			setAgentId(nestedSplit, "a", "claude"),
			"c",
			"copilot",
		);
		expect(collectAgentPanes(stamped)).toEqual([
			{ paneId: "a", agentId: "claude" },
			{ paneId: "c", agentId: "copilot" },
		]);
	});
});

describe("extractNode", () => {
	it("returns removed leaf and remaining sibling", () => {
		const { remaining, removed } = extractNode(simpleSplit, "a");
		expect(removed).toEqual(leafA);
		expect(remaining).toEqual(leafB);
	});

	it("returns null remaining when extracting the only node", () => {
		const { remaining, removed } = extractNode(leafA, "a");
		expect(removed).toEqual(leafA);
		expect(remaining).toBeNull();
	});

	it("returns original tree and null removed when id not found", () => {
		const { remaining, removed } = extractNode(simpleSplit, "nonexistent");
		expect(remaining).toEqual(simpleSplit);
		expect(removed).toBeNull();
	});

	it("preserves all ids in the removed subtree", () => {
		const { removed } = extractNode(nestedSplit, "s1");
		expect(removed).toEqual(simpleSplit);
	});

	it("remaining tree still contains untouched nodes", () => {
		const { remaining } = extractNode(nestedSplit, "a");
		expect(findNode(remaining!, "b")).toEqual(leafB);
		expect(findNode(remaining!, "c")).toEqual(leafC);
		expect(findNode(remaining!, "a")).toBeNull();
	});
});

describe("insertBesideNode", () => {
	const leafX: PaneNode = { type: "terminal", id: "x", ptyId: "pty-x" };

	it("inserts above target with top edge (horizontal split, new node first)", () => {
		const result = insertBesideNode(leafA, "a", leafX, "top");
		expect(result.type).toBe("split");
		if (result.type === "split") {
			expect(result.direction).toBe("horizontal");
			expect(result.first).toEqual(leafX);
			expect(result.second).toEqual(leafA);
		}
	});

	it("inserts below target with bottom edge (horizontal split, target first)", () => {
		const result = insertBesideNode(leafA, "a", leafX, "bottom");
		expect(result.type).toBe("split");
		if (result.type === "split") {
			expect(result.direction).toBe("horizontal");
			expect(result.first).toEqual(leafA);
			expect(result.second).toEqual(leafX);
		}
	});

	it("inserts left of target with left edge (vertical split, new node first)", () => {
		const result = insertBesideNode(leafA, "a", leafX, "left");
		expect(result.type).toBe("split");
		if (result.type === "split") {
			expect(result.direction).toBe("vertical");
			expect(result.first).toEqual(leafX);
			expect(result.second).toEqual(leafA);
		}
	});

	it("inserts right of target with right edge (vertical split, target first)", () => {
		const result = insertBesideNode(leafA, "a", leafX, "right");
		expect(result.type).toBe("split");
		if (result.type === "split") {
			expect(result.direction).toBe("vertical");
			expect(result.first).toEqual(leafA);
			expect(result.second).toEqual(leafX);
		}
	});

	it("inserts beside a nested node, preserving all other nodes", () => {
		const result = insertBesideNode(nestedSplit, "c", leafX, "right");
		expect(findNode(result, "a")).toEqual(leafA);
		expect(findNode(result, "b")).toEqual(leafB);
		expect(findNode(result, "c")).toEqual(leafC);
		expect(findNode(result, "x")).toEqual(leafX);
	});

	it("inserts with ratio 0.5 on the new split", () => {
		const result = insertBesideNode(leafA, "a", leafX, "top");
		if (result.type === "split") {
			expect(result.ratio).toBe(0.5);
		}
	});

	it("returns original tree when targetPaneId not found", () => {
		const result = insertBesideNode(leafA, "nonexistent", leafX, "top");
		expect(result).toEqual(leafA);
	});

	it("preserves stable ids: existing node ids unchanged after insert", () => {
		const result = insertBesideNode(nestedSplit, "b", leafX, "left");
		expect(findNode(result, "a")?.id).toBe("a");
		expect(findNode(result, "b")?.id).toBe("b");
		expect(findNode(result, "c")?.id).toBe("c");
	});
});

describe("preview panes", () => {
	const fileLeaf: PaneNode = {
		type: "file",
		id: "f1",
		filePath: "/a/README.md",
	};
	const previewLeaf: PaneNode = {
		type: "preview",
		id: "p1",
		sourcePaneId: "f1",
	};
	// File pane + its bound preview, side by side.
	const editorWithPreview: PaneNode = {
		type: "split",
		id: "sp",
		direction: "vertical",
		ratio: 0.5,
		first: fileLeaf,
		second: previewLeaf,
	};

	it("treats a preview as a leaf for tree traversal", () => {
		expect(findNode(editorWithPreview, "p1")).toBe(previewLeaf);
		expect(collectPaneIds(editorWithPreview)).toEqual(["f1", "p1"]);
		expect(collectTerminals(editorWithPreview)).toEqual([]);
		expect(collectTerminalIds(editorWithPreview)).toEqual([]);
		expect(collectFilePaneIds(editorWithPreview)).toEqual(["f1"]);
	});

	it("does not crash collectTerminals on a tree mixing terminals and previews", () => {
		const mixed: PaneNode = {
			type: "split",
			id: "m",
			direction: "horizontal",
			ratio: 0.5,
			first: editorWithPreview,
			second: leafA,
		};
		expect(collectTerminals(mixed)).toEqual([{ id: "a", ptyId: "pty-a" }]);
	});

	it("findPreviewForSource locates the preview bound to a source pane", () => {
		expect(findPreviewForSource(editorWithPreview, "f1")).toBe(previewLeaf);
		expect(findPreviewForSource(editorWithPreview, "nonexistent")).toBeNull();
		expect(findPreviewForSource(simpleSplit, "a")).toBeNull();
	});

	it("findOrphanPreviews returns nothing when the source resolves", () => {
		expect(findOrphanPreviews(editorWithPreview)).toEqual([]);
	});

	it("findOrphanPreviews flags a preview whose source is gone", () => {
		const orphaned: PaneNode = {
			type: "split",
			id: "o",
			direction: "vertical",
			ratio: 0.5,
			first: leafA,
			second: previewLeaf, // sourcePaneId "f1" not present
		};
		expect(findOrphanPreviews(orphaned)).toEqual([previewLeaf]);
	});

	it("pruneOrphanPreviews drops orphans and collapses the split", () => {
		const orphaned: PaneNode = {
			type: "split",
			id: "o",
			direction: "vertical",
			ratio: 0.5,
			first: leafA,
			second: previewLeaf,
		};
		expect(pruneOrphanPreviews(orphaned)).toEqual(leafA);
	});

	it("pruneOrphanPreviews returns the original tree when there are no orphans", () => {
		expect(pruneOrphanPreviews(editorWithPreview)).toBe(editorWithPreview);
	});

	it("removeNode of a source file pane leaves the preview as an orphan to prune", () => {
		const afterFileClose = removeNode(editorWithPreview, "f1");
		expect(afterFileClose).toEqual(previewLeaf);
		expect(findOrphanPreviews(afterFileClose as PaneNode)).toEqual([
			previewLeaf,
		]);
	});
});

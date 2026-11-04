import { describe, expect, it } from "vitest";
import {
	buildChangesTree,
	folderKey,
	type TreeRow,
	visibleTreeRows,
} from "../changesTree";
import type { GitChangedFile } from "../types";

function file(path: string): GitChangedFile {
	return { path, section: "unstaged", status: "M", additions: 0, deletions: 0 };
}

function shape(rows: TreeRow[]): string[] {
	return rows.map((r) =>
		r.kind === "folder"
			? `${"  ".repeat(r.depth)}${r.node.name}/`
			: `${"  ".repeat(r.depth)}${r.file.path.split("/").pop()}`,
	);
}

const open = () => false;

describe("buildChangesTree", () => {
	it("puts folders before files, each alphabetical, root files at the top level", () => {
		const tree = buildChangesTree([
			file("z.md"),
			file("b/x.ts"),
			file("a.md"),
			file("a/y.ts"),
			file("b/w.ts"),
		]);
		expect(shape(visibleTreeRows(tree, open))).toEqual([
			"a/",
			"  y.ts",
			"b/",
			"  w.ts",
			"  x.ts",
			"a.md",
			"z.md",
		]);
	});

	it("merges a chain of single-folder folders and names it by the whole chain", () => {
		const tree = buildChangesTree([
			file("src/components/GitChanges/List.tsx"),
			file("src/lib/a.ts"),
		]);
		expect(shape(visibleTreeRows(tree, open))).toEqual([
			"src/",
			"  components/GitChanges/",
			"    List.tsx",
			"  lib/",
			"    a.ts",
		]);
	});

	it("gives a merged row the path of its deepest folder", () => {
		const [node] = buildChangesTree([file("a/b/c/d.ts")]);
		expect(node).toMatchObject({
			kind: "folder",
			name: "a/b/c",
			path: "a/b/c",
		});
	});

	it("does not merge a folder that also holds files", () => {
		const tree = buildChangesTree([file("a/one.ts"), file("a/b/two.ts")]);
		expect(shape(visibleTreeRows(tree, open))).toEqual([
			"a/",
			"  b/",
			"    two.ts",
			"  one.ts",
		]);
	});

	it("returns nothing for no files", () => {
		expect(buildChangesTree([])).toEqual([]);
	});
});

describe("visibleTreeRows", () => {
	it("hides a folded folder's contents but keeps its row", () => {
		const tree = buildChangesTree([
			file("a/b/x.ts"),
			file("a/y.ts"),
			file("c.ts"),
		]);
		const rows = visibleTreeRows(tree, (p) => p === "a");
		expect(shape(rows)).toEqual(["a/", "c.ts"]);
		expect(rows[0]).toMatchObject({ kind: "folder", collapsed: true });
	});
});

describe("folderKey", () => {
	it("keeps the same folder in different Sections apart", () => {
		expect(folderKey("staged", "src")).not.toBe(folderKey("unstaged", "src"));
	});
});

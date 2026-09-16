import { describe, expect, it } from "vitest";
import {
	branchStatOf,
	branchStatTooltip,
	uncommittedEqual,
	uncommittedOf,
	uncommittedTooltip,
} from "../dirtyWorkspace";
import type { GitChangedFile } from "../types";

const file = (
	path: string,
	section: GitChangedFile["section"],
	additions = 0,
	deletions = 0,
): GitChangedFile => ({ path, section, status: "M", additions, deletions });

describe("uncommittedOf", () => {
	it("is clean when the only changes are committed history against base", () => {
		const u = uncommittedOf([
			file("a.ts", "against_base", 10, 2),
			file("b.ts", "against_base", 1, 0),
		]);
		expect(u.dirty).toBe(false);
		expect(u.breakdown).toEqual({
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflicted: 0,
		});
	});

	it("is clean for an empty list", () => {
		expect(uncommittedOf([]).dirty).toBe(false);
	});

	it.each([
		"staged",
		"unstaged",
		"untracked",
		"conflicted",
	] as const)("is dirty with a %s path", (section) => {
		const u = uncommittedOf([file("a.ts", section)]);
		expect(u.dirty).toBe(true);
		expect(u.breakdown?.[section]).toBe(1);
	});

	it("counts distinct paths per section", () => {
		const u = uncommittedOf([
			file("a.ts", "staged"),
			file("a.ts", "unstaged"),
			file("b.ts", "unstaged"),
			file("a.ts", "against_base"),
		]);
		expect(u.breakdown).toEqual({
			staged: 1,
			unstaged: 2,
			untracked: 0,
			conflicted: 0,
		});
	});
});

describe("branchStatOf", () => {
	it("counts a file listed in several sections once, and sums its lines", () => {
		const stat = branchStatOf([
			file("a.ts", "against_base", 10, 2),
			file("a.ts", "unstaged", 3, 1),
			file("b.ts", "untracked", 5, 0),
		]);
		expect(stat).toEqual({ changedFileCount: 2, additions: 18, deletions: 3 });
	});
});

describe("uncommittedEqual", () => {
	const live = uncommittedOf([file("a.ts", "staged")]);
	it("treats identical live values as equal", () => {
		expect(uncommittedEqual(live, uncommittedOf([file("x", "staged")]))).toBe(
			true,
		);
	});
	it("distinguishes a live value from a summary value", () => {
		expect(uncommittedEqual(live, { dirty: true, breakdown: null })).toBe(
			false,
		);
	});
	it("distinguishes different breakdowns", () => {
		expect(
			uncommittedEqual(live, uncommittedOf([file("a.ts", "unstaged")])),
		).toBe(false);
	});
});

describe("uncommittedTooltip", () => {
	it("says only that there are changes when the value came from the summary", () => {
		expect(uncommittedTooltip({ dirty: true, breakdown: null })).toBe(
			"Uncommitted changes",
		);
	});

	it("lists non-zero sections in order for a live value", () => {
		expect(
			uncommittedTooltip({
				dirty: true,
				breakdown: { staged: 2, unstaged: 3, untracked: 0, conflicted: 1 },
			}),
		).toBe("Uncommitted: 2 staged · 3 unstaged · 1 conflicted");
	});
});

describe("branchStatTooltip", () => {
	const stat = { changedFileCount: 5, additions: 200, deletions: 30 };

	it("names the base branch", () => {
		expect(branchStatTooltip(stat, "main")).toBe(
			"vs main: 5 files, +200 −30, including uncommitted",
		);
	});

	it("falls back to the default branch and singularises one file", () => {
		expect(branchStatTooltip({ ...stat, changedFileCount: 1 }, null)).toBe(
			"vs the default branch: 1 file, +200 −30, including uncommitted",
		);
	});
});

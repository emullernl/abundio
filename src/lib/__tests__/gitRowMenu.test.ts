import { describe, expect, it } from "vitest";

import {
	type GitRowMenuAction,
	type GitRowMenuEntry,
	gitRowMenuEntries,
	revealLabel,
} from "../gitRowMenu";

function actions(entries: GitRowMenuEntry[]): GitRowMenuAction[] {
	return entries.filter((e): e is GitRowMenuAction => !("separator" in e));
}

function ids(entries: GitRowMenuEntry[]) {
	return actions(entries).map((e) => e.id);
}

function disabledIds(entries: GitRowMenuEntry[]) {
	return actions(entries)
		.filter((e) => e.disabled)
		.map((e) => e.id);
}

describe("gitRowMenuEntries", () => {
	it("holds no git writes and no terminal handoff", () => {
		// The Row menu is read-only by design: Resolve & stage stays Abundio's
		// one deliberate writer to the index (ADR-0029).
		const labels = actions(
			gitRowMenuEntries({ status: "M", section: "unstaged" }),
		).map((e) => e.label.toLowerCase());
		for (const forbidden of ["stage", "unstage", "discard", "revert", "run"]) {
			expect(labels.some((l) => l.includes(forbidden))).toBe(false);
		}
	});

	it("keeps the same shape on every row", () => {
		const shapes = [
			{ status: "M", section: "unstaged" },
			{ status: "D", section: "staged" },
			{ status: "?", section: "untracked" },
			{ status: "U", section: "conflicted" },
		].map((f) => ids(gitRowMenuEntries(f)));

		for (const shape of shapes) {
			expect(shape).toEqual(shapes[0]);
		}
	});

	it("disables nothing on an ordinary modified row", () => {
		expect(
			disabledIds(gitRowMenuEntries({ status: "M", section: "unstaged" })),
		).toEqual([]);
	});

	it("disables the on-disk actions for a deleted path", () => {
		expect(
			disabledIds(gitRowMenuEntries({ status: "D", section: "staged" })),
		).toEqual(["open-file", "reveal"]);
	});

	it("disables Open Diff on a conflicted row", () => {
		// An unmerged path has no stage 0, so no endpoint pair to diff.
		expect(
			disabledIds(gitRowMenuEntries({ status: "U", section: "conflicted" })),
		).toEqual(["open-diff"]);
	});

	it("puts the relative path first — it is what a terminal in the repo wants", () => {
		const order = ids(gitRowMenuEntries({ status: "M", section: "unstaged" }));
		expect(order.indexOf("copy-relative-path")).toBeLessThan(
			order.indexOf("copy-path"),
		);
	});

	it("names the file manager per platform", () => {
		expect(revealLabel("MacIntel")).toBe("Reveal in Finder");
		expect(revealLabel("Win32")).toBe("Reveal in Explorer");
		expect(revealLabel("Linux x86_64")).toBe("Reveal in File Manager");
	});
});

import { describe, expect, it } from "vitest";

import {
	type GitRowMenuAction,
	type GitRowMenuEntry,
	gitRowMenuEntries,
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

/** Every row state the Git changes tab can produce, on an ordinary text file. */
const ROW_SHAPES = [
	{ path: "src/a.ts", status: "M", section: "unstaged" },
	{ path: "src/a.ts", status: "D", section: "staged" },
	{ path: "src/a.ts", status: "?", section: "untracked" },
	{ path: "src/a.ts", status: "U", section: "conflicted" },
];

describe("gitRowMenuEntries", () => {
	it("holds no git writes and no terminal handoff, on any row shape", () => {
		// The Row menu is read-only by design: Resolve & stage stays Abundio's
		// one deliberate writer to the index (ADR-0029). Checked across every row
		// shape, because the obvious way to slip a write in is to gate it on a
		// section or status the roster is never inspected under.
		const forbidden = [
			"stage",
			"unstage",
			"discard",
			"revert",
			"restore",
			"checkout",
			"reset",
			"clean",
			"delete",
			"run",
		];
		for (const file of ROW_SHAPES) {
			const labels = actions(gitRowMenuEntries(file)).map((e) =>
				e.label.toLowerCase(),
			);
			for (const word of forbidden) {
				expect(
					labels.some((l) => l.includes(word)),
					`${word} in ${file.section}/${file.status}`,
				).toBe(false);
			}
		}
	});

	it("keeps the same shape on every row of a kind", () => {
		const shapes = ROW_SHAPES.map((f) => ids(gitRowMenuEntries(f)));

		for (const shape of shapes) {
			expect(shape).toEqual(shapes[0]);
		}
	});

	it("disables nothing on an ordinary modified row", () => {
		expect(
			disabledIds(
				gitRowMenuEntries({
					path: "src/a.ts",
					status: "M",
					section: "unstaged",
				}),
			),
		).toEqual([]);
	});

	it("disables the on-disk actions for a deleted path", () => {
		expect(
			disabledIds(
				gitRowMenuEntries({ path: "src/a.ts", status: "D", section: "staged" }),
			),
		).toEqual(["open-file", "open-file-window", "reveal"]);
	});

	it("disables Open Diff on a conflicted row", () => {
		// An unmerged path has no stage 0, so no endpoint pair to diff.
		expect(
			disabledIds(
				gitRowMenuEntries({
					path: "src/a.ts",
					status: "U",
					section: "conflicted",
				}),
			),
		).toEqual(["open-diff", "open-diff-window"]);
	});

	it("disables Open Diff on a binary commit file, and only that", () => {
		expect(
			disabledIds(
				gitRowMenuEntries({
					path: "src/a.ts",
					status: "M",
					section: "commit",
					isBinary: true,
				}),
			),
		).toEqual(["open-diff", "open-diff-window"]);
	});

	it("disables Open Diff and Open File on a submodule", () => {
		// No text to diff, and on disk it is a folder, not a file.
		expect(
			disabledIds(
				gitRowMenuEntries({
					path: "vendor/lib",
					status: "M",
					section: "commit",
					isSubmodule: true,
				}),
			),
		).toEqual(["open-diff", "open-file"]);
	});

	describe("Open Diff / Open File in Separate Window", () => {
		const row = (path: string, status: string, section: string) =>
			gitRowMenuEntries({ path, status, section });
		const WINDOW_IDS = ["open-diff-window", "open-file-window"];

		it("appears on every row whose file has a File window", () => {
			for (const path of [
				"docs/notes.md",
				"src/a.ts",
				"logo.PNG",
				"Makefile",
			]) {
				const got = ids(row(path, "M", "unstaged"));
				for (const id of WINDOW_IDS) expect(got, path).toContain(id);
			}
		});

		it("is absent on a file a File pane cannot show", () => {
			for (const path of ["dist/app.zip", "fonts/a.woff2", "doc.pdf"]) {
				const got = ids(row(path, "M", "unstaged"));
				for (const id of WINDOW_IDS) expect(got, path).not.toContain(id);
			}
		});

		it("sits right after Open File, with the other open actions", () => {
			expect(ids(row("src/a.ts", "M", "unstaged")).slice(0, 4)).toEqual([
				"open-diff",
				"open-file",
				"open-diff-window",
				"open-file-window",
			]);
		});

		// File kind may change the shape; row state still only disables.
		it("keeps one shape across every row state", () => {
			const shapes = [
				row("docs/notes.md", "M", "unstaged"),
				row("docs/notes.md", "D", "staged"),
				row("docs/notes.md", "?", "untracked"),
				row("docs/notes.md", "U", "conflicted"),
				row("docs/notes.md", "D", "commit"),
			].map(ids);
			for (const shape of shapes) expect(shape).toEqual(shapes[0]);
		});

		it("follows Open File on a deleted path", () => {
			expect(disabledIds(row("docs/notes.md", "D", "staged"))).toEqual([
				"open-file",
				"open-file-window",
				"reveal",
			]);
			// A path the commit deleted, likewise. Its diff still opens.
			const commitDeleted = disabledIds(row("docs/notes.md", "D", "commit"));
			expect(commitDeleted).toContain("open-file-window");
			expect(commitDeleted).not.toContain("open-diff-window");
		});

		// The file is opened as it is on disk, markers and all, as Open File is;
		// there is no diff, as with Open Diff.
		it("follows Open Diff and Open File on a conflicted row", () => {
			expect(disabledIds(row("docs/notes.md", "U", "conflicted"))).toEqual([
				"open-diff",
				"open-diff-window",
			]);
		});

		// A submodule is a folder on disk — a kind, not a state — so the items
		// are absent, not disabled, whatever its name.
		it("is not offered on a submodule, whatever its name", () => {
			const got = ids(
				gitRowMenuEntries({
					path: "vendor/docs.md",
					status: "M",
					section: "commit",
					isSubmodule: true,
				}),
			);
			for (const id of WINDOW_IDS) expect(got).not.toContain(id);
		});

		it("is enabled on a commit file that still exists", () => {
			expect(disabledIds(row("docs/notes.md", "M", "commit"))).toEqual([]);
		});
	});

	it("puts the relative path first — it is what a terminal in the repo wants", () => {
		const order = ids(
			gitRowMenuEntries({ path: "src/a.ts", status: "M", section: "unstaged" }),
		);
		expect(order.indexOf("copy-relative-path")).toBeLessThan(
			order.indexOf("copy-path"),
		);
	});
});

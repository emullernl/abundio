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

/** Every row state the Git changes tab can produce, on a non-markdown file. */
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
		).toEqual(["open-file", "reveal"]);
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
		).toEqual(["open-diff"]);
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
		).toEqual(["open-diff"]);
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

	describe("Open in Markdown Window", () => {
		const md = (status: string, section: string) =>
			gitRowMenuEntries({ path: "docs/notes.md", status, section });

		it("appears only on a markdown file's row", () => {
			expect(ids(md("M", "unstaged"))).toContain("open-markdown-window");
			expect(
				ids(
					gitRowMenuEntries({
						path: "docs/page.MDX",
						status: "M",
						section: "unstaged",
					}),
				),
			).toContain("open-markdown-window");
			for (const file of ROW_SHAPES) {
				expect(ids(gitRowMenuEntries(file))).not.toContain(
					"open-markdown-window",
				);
			}
		});

		it("sits right after Open File, with the other open actions", () => {
			const order = ids(md("M", "unstaged"));
			expect(order.slice(0, 3)).toEqual([
				"open-diff",
				"open-file",
				"open-markdown-window",
			]);
		});

		// File kind may change the shape; row state still only disables.
		it("keeps one shape across every markdown row state", () => {
			const shapes = [
				md("M", "unstaged"),
				md("D", "staged"),
				md("?", "untracked"),
				md("U", "conflicted"),
				md("D", "commit"),
			].map(ids);
			for (const shape of shapes) expect(shape).toEqual(shapes[0]);
		});

		it("is disabled where Open File is: a deleted path", () => {
			expect(disabledIds(md("D", "staged"))).toEqual([
				"open-file",
				"open-markdown-window",
				"reveal",
			]);
			// A path the commit deleted, likewise.
			expect(disabledIds(md("D", "commit"))).toContain("open-markdown-window");
		});

		// The file is opened as it is on disk, markers and all, as Open File is.
		it("stays enabled on a conflicted row", () => {
			expect(disabledIds(md("U", "conflicted"))).toEqual(["open-diff"]);
		});

		// A submodule is a folder on disk — a kind, not a state — so the item is
		// absent, not disabled, even when the name looks like markdown.
		it("is not offered on a submodule, whatever its name", () => {
			expect(
				ids(
					gitRowMenuEntries({
						path: "vendor/docs.md",
						status: "M",
						section: "commit",
						isSubmodule: true,
					}),
				),
			).not.toContain("open-markdown-window");
		});

		it("is enabled on a commit file that still exists", () => {
			expect(disabledIds(md("M", "commit"))).toEqual([]);
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

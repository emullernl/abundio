import { describe, expect, it } from "vitest";
import { conflictDecorations } from "../conflictLenses";
import { parseConflicts } from "../conflictMarkers";

const TWO_WAY = [
	"before",
	"<<<<<<< HEAD",
	"ours",
	"=======",
	"theirs",
	">>>>>>> feature/x",
	"",
].join("\n");

const DIFF3 = [
	"<<<<<<< HEAD",
	"ours",
	"||||||| base",
	"anc",
	"=======",
	"theirs",
	">>>>>>> other",
	"",
].join("\n");

const classesOn = (
	decos: ReturnType<typeof conflictDecorations>,
	line: number,
) =>
	decos
		.filter((d) => d.range.startLineNumber === line)
		.map((d) => d.options.className);

describe("conflictDecorations", () => {
	it("marks all four marker lines of a diff3 block", () => {
		const decos = conflictDecorations(parseConflicts(DIFF3));
		for (const line of [1, 3, 5, 7]) {
			expect(classesOn(decos, line)).toContain("abundio-conflict-marker");
		}
	});

	it("marks both marker lines of a two-way block", () => {
		const decos = conflictDecorations(parseConflicts(TWO_WAY));
		expect(classesOn(decos, 2)).toContain("abundio-conflict-marker");
		expect(classesOn(decos, 4)).toContain("abundio-conflict-marker");
		expect(classesOn(decos, 6)).toContain("abundio-conflict-marker");
	});

	it("colours the current and incoming sides distinctly", () => {
		const decos = conflictDecorations(parseConflicts(TWO_WAY));
		expect(classesOn(decos, 3)).toContain("abundio-conflict-current");
		expect(classesOn(decos, 5)).toContain("abundio-conflict-incoming");
	});

	it("colours the ancestor region under diff3", () => {
		const decos = conflictDecorations(parseConflicts(DIFF3));
		expect(classesOn(decos, 4)).toContain("abundio-conflict-base");
	});

	it("never decorates content lines of an empty side", () => {
		const src = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> x", ""].join(
			"\n",
		);
		const decos = conflictDecorations(parseConflicts(src));
		// An empty current side must not paint the separator line beneath it.
		expect(classesOn(decos, 2)).not.toContain("abundio-conflict-current");
	});

	it("produces nothing for a file with no conflicts", () => {
		expect(conflictDecorations(parseConflicts("plain\ntext\n"))).toEqual([]);
	});

	it("puts a glyph on every marker line", () => {
		const decos = conflictDecorations(parseConflicts(TWO_WAY));
		const glyphs = decos.filter(
			(d) => d.options.glyphMarginClassName === "abundio-conflict-glyph",
		);
		expect(glyphs).toHaveLength(3);
	});
});

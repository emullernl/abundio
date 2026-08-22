import { describe, expect, it } from "vitest";
import { conflictDecorations, sideDecorations } from "../conflictLenses";
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

describe("sideDecorations", () => {
	const ranges = [
		{ startLine: 3, endLine: 5 },
		{ startLine: 10, endLine: 11 },
	];
	const classesAt = (decos: ReturnType<typeof sideDecorations>, line: number) =>
		decos
			.filter(
				(d) => d.range.startLineNumber <= line && d.range.endLineNumber >= line,
			)
			.flatMap((d) =>
				[d.options.className, d.options.linesDecorationsClassName].filter(
					(c): c is string => typeof c === "string",
				),
			)
			.join(" ");

	it("dims every line outside a conflict region", () => {
		const d = sideDecorations(ranges, null, 14, "current");
		for (const line of [1, 2, 6, 9, 12, 14]) {
			expect(classesAt(d, line)).toContain("abundio-side-dim");
		}
	});

	it("never dims a conflict region", () => {
		const d = sideDecorations(ranges, null, 14, "current");
		for (const line of [3, 4, 5, 10, 11]) {
			expect(classesAt(d, line)).not.toContain("abundio-side-dim");
		}
	});

	it("spans the gaps whole rather than decorating line by line", () => {
		// N+1 gaps, not one decoration per line — this is what keeps a large
		// stage document cheap.
		const dims = sideDecorations(ranges, null, 500, "current").filter(
			(d) => d.options.className === "abundio-side-dim",
		);
		expect(dims).toHaveLength(3);
	});

	it("colours the rail by side", () => {
		expect(
			classesAt(sideDecorations(ranges, null, 14, "current"), 3),
		).toContain("abundio-side-current");
		expect(
			classesAt(sideDecorations(ranges, null, 14, "incoming"), 3),
		).toContain("abundio-side-incoming");
	});

	it("marks only the active region as active", () => {
		const d = sideDecorations(ranges, 1, 14, "current");
		expect(classesAt(d, 4)).not.toContain("abundio-side-active");
		expect(classesAt(d, 10)).toContain("abundio-side-active");
	});

	it("gives the active region hard top and bottom edges", () => {
		const d = sideDecorations(ranges, 0, 14, "current");
		expect(classesAt(d, 3)).toContain("abundio-side-edge-top");
		expect(classesAt(d, 5)).toContain("abundio-side-edge-bottom");
		expect(classesAt(d, 4)).not.toContain("abundio-side-edge");
	});

	it("marks an empty side as a seam instead of a band", () => {
		// startLine > endLine: this side contributes nothing to the block, which
		// must read as deliberate rather than as a failed lookup.
		const d = sideDecorations([{ startLine: 7, endLine: 6 }], 0, 14, "current");
		expect(classesAt(d, 7)).toContain("abundio-side-empty");
		expect(classesAt(d, 7)).not.toContain("abundio-side-hit");
	});

	it("skips blocks that could not be located", () => {
		const d = sideDecorations([null, ranges[1]], null, 14, "incoming");
		expect(classesAt(d, 10)).toContain("abundio-side-hit");
		// Everything else is simply dim; a missing block adds no marks.
		expect(classesAt(d, 3)).toContain("abundio-side-dim");
	});

	it("dims the whole document when there are no regions", () => {
		const d = sideDecorations([], null, 20, "base");
		expect(d).toHaveLength(1);
		expect(d[0].range.startLineNumber).toBe(1);
		expect(d[0].range.endLineNumber).toBe(20);
	});
});

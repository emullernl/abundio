import { describe, expect, it } from "vitest";
import {
	applyChoice,
	conflictDecorations,
	resultLensSpecs,
	sideDecorations,
	sideLensSpecs,
} from "../conflictLenses";
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

describe("resultLensSpecs", () => {
	it("offers every choice above each block's opener", () => {
		const [spec] = resultLensSpecs(parseConflicts(TWO_WAY));
		expect(spec.line).toBe(2);
		expect(spec.blockIndex).toBe(0);
		expect(spec.actions.map((a) => a.title)).toEqual([
			"Accept Current",
			"Accept Incoming",
			"Accept Both",
		]);
	});

	it("offers the ancestor only under diff3", () => {
		const [spec] = resultLensSpecs(parseConflicts(DIFF3));
		expect(spec.actions.map((a) => a.choice)).toContain("base");
	});

	it("numbers each block so the command knows which one it edits", () => {
		const specs = resultLensSpecs(parseConflicts(TWO_WAY + TWO_WAY));
		expect(specs.map((s) => s.blockIndex)).toEqual([0, 1]);
	});
});

describe("sideLensSpecs", () => {
	const ranges = [
		{ startLine: 3, endLine: 5 },
		{ startLine: 10, endLine: 11 },
	];

	it("speaks from the Current side's point of view", () => {
		const [spec] = sideLensSpecs(ranges, "current");
		expect(spec.actions).toEqual([
			{ title: "Accept Current", choice: "current" },
			{ title: "Accept Both", choice: "both" },
			// "Discard Current" means the result keeps the other side — spelled
			// out rather than VS Code's bare "Ignore", which does not say what
			// you end up with.
			{ title: "Discard Current", choice: "incoming" },
		]);
	});

	it("speaks from the Incoming side's point of view", () => {
		const [spec] = sideLensSpecs(ranges, "incoming");
		expect(spec.actions).toEqual([
			{ title: "Accept Incoming", choice: "incoming" },
			{ title: "Accept Both", choice: "both" },
			{ title: "Discard Incoming", choice: "current" },
		]);
	});

	it("anchors each row above its own region", () => {
		const specs = sideLensSpecs(ranges, "current");
		expect(specs.map((s) => s.line)).toEqual([3, 10]);
	});

	it("keeps the block index aligned with the source blocks", () => {
		// A block this side could not be located in must not shift the indices
		// of the ones after it, or the lens would edit the wrong conflict.
		const specs = sideLensSpecs([null, ranges[1]], "incoming");
		expect(specs).toHaveLength(1);
		expect(specs[0].blockIndex).toBe(1);
	});

	it("offers nothing on the ancestor pane", () => {
		// Base is reference only — "accept the ancestor" is already available in
		// the result pane, and offering it here would imply the pane is editable.
		expect(sideLensSpecs(ranges, "base")).toEqual([]);
	});
});

describe("applyChoice", () => {
	function fakeEditor(text: string) {
		const edits: { range: unknown; text: string }[] = [];
		const lines = text.split("\n");
		const offsetToPos = (offset: number) => {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				const len = lines[i].length + 1;
				if (remaining < len) {
					return { lineNumber: i + 1, column: remaining + 1 };
				}
				remaining -= len;
			}
			return {
				lineNumber: lines.length,
				column: lines[lines.length - 1].length + 1,
			};
		};
		return {
			edits,
			getModel: () => ({
				getValue: () => text,
				getPositionAt: offsetToPos,
				getLineCount: () => lines.length,
			}),
			executeEdits: (_src: string, e: typeof edits) => edits.push(...e),
			pushUndoStop: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal editor stand-in
		} as any;
	}

	const SRC = [
		"head",
		"<<<<<<< HEAD",
		"ours",
		"=======",
		"theirs",
		">>>>>>> main",
		"tail",
		"",
	].join("\n");

	/** Apply the recorded edit the way Monaco would, to check the result. */
	function applied(text: string, edit: { range: never; text: string }) {
		const lines = text.split("\n");
		const offsetOf = (line: number, column: number) =>
			lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) +
			(column - 1);
		const r = edit.range as unknown as {
			startLineNumber: number;
			startColumn: number;
			endLineNumber: number;
			endColumn: number;
		};
		return (
			text.slice(0, offsetOf(r.startLineNumber, r.startColumn)) +
			edit.text +
			text.slice(offsetOf(r.endLineNumber, r.endColumn))
		);
	}

	it("replaces exactly the block with the chosen side", () => {
		const ed = fakeEditor(SRC);
		applyChoice(ed, 0, "current");
		expect(ed.edits).toHaveLength(1);
		expect(applied(SRC, ed.edits[0])).toBe("head\nours\ntail\n");
	});

	it("keeps both sides in order for 'both'", () => {
		const ed = fakeEditor(SRC);
		applyChoice(ed, 0, "both");
		expect(applied(SRC, ed.edits[0])).toBe("head\nours\ntheirs\ntail\n");
	});

	it("edits the second block without disturbing the first", () => {
		const two = SRC + SRC;
		const ed = fakeEditor(two);
		applyChoice(ed, 1, "incoming");
		expect(applied(two, ed.edits[0])).toBe(
			"head\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\ntail\nhead\ntheirs\ntail\n",
		);
	});

	it("parses from the model, not from a caller's copy of the file", () => {
		// Monaco normalises a model's EOLs on creation, so offsets taken from the
		// store's copy of a mixed-EOL file are shifted and the splice lands
		// mid-line. Re-parsing from getValue() is what keeps them consistent.
		const normalised = SRC; // what the model holds
		const ed = fakeEditor(normalised);
		applyChoice(ed, 0, "current");
		expect(applied(normalised, ed.edits[0])).toBe("head\nours\ntail\n");
	});

	it("does nothing when the block index is out of range", () => {
		const ed = fakeEditor(SRC);
		applyChoice(ed, 7, "current");
		expect(ed.edits).toHaveLength(0);
	});

	it("does nothing on a file with no conflicts", () => {
		const ed = fakeEditor("just text\n");
		applyChoice(ed, 0, "current");
		expect(ed.edits).toHaveLength(0);
	});
});

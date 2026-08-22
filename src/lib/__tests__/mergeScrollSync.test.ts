import { beforeEach, describe, expect, it } from "vitest";
import { parseConflicts } from "../conflictMarkers";
import {
	buildSideAnchors,
	mapLine,
	registerResultEditor,
	registerSideEditor,
	resetMergeScrollSync,
} from "../mergeScrollSync";

// Result document: 3 lines of preamble, a conflict, then a tail.
const RESULT = [
	"one", // 1
	"two", // 2
	"three", // 3
	"<<<<<<< HEAD", // 4
	"ours a", // 5
	"ours b", // 6
	"=======", // 7
	"theirs a", // 8
	">>>>>>> main", // 9
	"tail", // 10
	"",
].join("\n");

const BLOCKS = parseConflicts(RESULT);

// The "ours" stage: same preamble, its own two lines, same tail.
const OURS_RANGES = [{ startLine: 4, endLine: 5 }];
const OURS_LINES = 6;

describe("buildSideAnchors", () => {
	it("anchors both ends of a located region, plus both document ends", () => {
		const anchors = buildSideAnchors(BLOCKS, OURS_RANGES, 10, OURS_LINES);
		expect(anchors).toEqual([
			{ result: 1, side: 1 },
			// The whole block — opener through closer — against the side's region,
			// so the shared text on either side of it maps exactly.
			{ result: 4, side: 4 },
			{ result: 10, side: 6 },
			{ result: 11, side: 7 }, // one past document end
		]);
	});

	it("keeps anchors strictly increasing on both axes", () => {
		// An empty side would otherwise produce a flat or backwards step, and the
		// interpolation would divide by zero or map backwards.
		const anchors = buildSideAnchors(
			BLOCKS,
			[{ startLine: 4, endLine: 3 }],
			10,
			5,
		);
		for (let i = 1; i < anchors.length; i++) {
			expect(anchors[i].result).toBeGreaterThan(anchors[i - 1].result);
			expect(anchors[i].side).toBeGreaterThan(anchors[i - 1].side);
		}
	});

	it("skips a block this side could not be located in", () => {
		const anchors = buildSideAnchors(BLOCKS, [null], 10, OURS_LINES);
		expect(anchors).toEqual([
			{ result: 1, side: 1 },
			{ result: 11, side: 7 },
		]);
	});

	it("returns a usable pair for a file with no conflicts", () => {
		expect(buildSideAnchors([], [], 8, 8)).toEqual([
			{ result: 1, side: 1 },
			{ result: 9, side: 9 },
		]);
	});
});

describe("mapLine", () => {
	const anchors = buildSideAnchors(BLOCKS, OURS_RANGES, 10, OURS_LINES);

	it("maps the shared preamble one-to-one", () => {
		// Before the first conflict the documents are the same text, so this must
		// be exact rather than approximate.
		for (const line of [1, 2, 3]) {
			expect(mapLine(anchors, line, "result")).toBeCloseTo(line);
		}
	});

	it("maps the block opener exactly onto the region start", () => {
		expect(mapLine(anchors, 4, "result")).toBe(4);
	});

	it("keeps the shared tail aligned after the conflict", () => {
		// The whole point: a flat scrollTop sync drifts by the marker lines plus
		// the other side's content, so the tail would be four lines out here.
		expect(mapLine(anchors, 10, "result")).toBe(6);
	});

	it("inverts", () => {
		expect(mapLine(anchors, 4, "side")).toBe(4);
		expect(mapLine(anchors, 6, "side")).toBe(10);
		expect(mapLine(anchors, 1, "side")).toBe(1);
	});

	it("is monotonic across the whole document", () => {
		let previous = Number.NEGATIVE_INFINITY;
		for (let line = 1; line <= 12; line += 0.5) {
			const mapped = mapLine(anchors, line, "result");
			expect(mapped).toBeGreaterThanOrEqual(previous);
			previous = mapped;
		}
	});

	it("extrapolates past the last anchor instead of clamping", () => {
		// Overscroll at the bottom should keep moving, not stick.
		expect(mapLine(anchors, 20, "result")).toBeGreaterThan(
			mapLine(anchors, 15, "result"),
		);
	});

	it("handles fractional lines, since scroll offsets are not whole lines", () => {
		const mapped = mapLine(anchors, 2.5, "result");
		expect(mapped).toBeGreaterThan(2);
		expect(mapped).toBeLessThan(3);
	});

	it("is the identity when there are no anchors", () => {
		expect(mapLine([], 42, "result")).toBe(42);
	});
});

describe("scroll sync wiring", () => {
	/** `rowsPerLine` lets a test simulate word wrap: a line occupying several
	 *  visual rows makes offsets non-uniform, which is exactly what a single
	 *  line-height multiplication gets wrong. */
	function fakeEditor(rowsPerLine: (line: number) => number = () => 1) {
		let scrollTop = 0;
		const handlers: (() => void)[] = [];
		const topFor = (n: number) => {
			let top = 0;
			for (let i = 1; i < n; i++) top += rowsPerLine(i) * 20;
			return top;
		};
		return {
			scrollTops: [] as number[],
			getModel: () => ({ getLineCount: () => 40 }),
			getTopForLineNumber: topFor,
			topFor,
			getScrollTop: () => scrollTop,
			setScrollTop(next: number) {
				scrollTop = next;
				(this as unknown as { scrollTops: number[] }).scrollTops.push(next);
			},
			onDidScrollChange(fn: () => void) {
				handlers.push(fn);
				return { dispose: () => handlers.splice(handlers.indexOf(fn), 1) };
			},
			/** Simulate the user dragging this editor's scrollbar. */
			scrollToLine(line: number) {
				scrollTop = topFor(line);
				for (const fn of handlers) fn();
			},
			handlers,
			// biome-ignore lint/suspicious/noExplicitAny: minimal editor stand-in
		} as any;
	}

	const anchors = buildSideAnchors(BLOCKS, OURS_RANGES, 10, OURS_LINES);

	beforeEach(() => resetMergeScrollSync());

	it("drives the sides from the result pane, mapped not copied", () => {
		const result = fakeEditor();
		const side = fakeEditor();
		registerResultEditor("src", result);
		registerSideEditor("src", "side-1", side, anchors);

		// Result line 10 is the shared tail, which is side line 6.
		result.scrollToLine(10);
		expect(side.scrollTops[side.scrollTops.length - 1]).toBe(side.topFor(6));
	});

	it("drives the result pane from a side", () => {
		const result = fakeEditor();
		const side = fakeEditor();
		registerResultEditor("src", result);
		registerSideEditor("src", "side-1", side, anchors);

		side.scrollToLine(6);
		expect(result.scrollTops[result.scrollTops.length - 1]).toBe(
			result.topFor(10),
		);
	});

	it("keeps two sides in step with each other", () => {
		const result = fakeEditor();
		const current = fakeEditor();
		const incoming = fakeEditor();
		registerResultEditor("src", result);
		registerSideEditor("src", "cur", current, anchors);
		registerSideEditor("src", "inc", incoming, anchors);

		current.scrollToLine(6);
		expect(incoming.scrollTops[incoming.scrollTops.length - 1]).toBe(
			incoming.topFor(6),
		);
	});

	it("does not echo back to the pane that was scrolled", () => {
		// Without the guard, applying a scroll fires onDidScrollChange again and
		// the panes ping-pong.
		const result = fakeEditor();
		const side = fakeEditor();
		registerResultEditor("src", result);
		registerSideEditor("src", "side-1", side, anchors);

		result.scrollToLine(10);
		expect(result.scrollTops).toHaveLength(0);
		expect(side.scrollTops).toHaveLength(1);
	});

	it("stops driving a pane once it unregisters", () => {
		const result = fakeEditor();
		const side = fakeEditor();
		const unregisterResult = registerResultEditor("src", result);
		registerSideEditor("src", "side-1", side, anchors);

		unregisterResult();
		side.scrollToLine(6);
		expect(result.scrollTops).toHaveLength(0);
	});

	it("keeps separate merge views independent", () => {
		const resultA = fakeEditor();
		const sideA = fakeEditor();
		const sideB = fakeEditor();
		registerResultEditor("a", resultA);
		registerSideEditor("a", "a-side", sideA, anchors);
		registerSideEditor("b", "b-side", sideB, anchors);

		resultA.scrollToLine(10);
		expect(sideA.scrollTops).toHaveLength(1);
		expect(sideB.scrollTops).toHaveLength(0);
	});
});

describe("scroll sync under word wrap", () => {
	// CodeEditor passes the user's editorWordWrap setting to the side panes too,
	// so a line can occupy several visual rows. A single line-height
	// multiplication drifts further down the document with every wrapped line.
	function wrappedEditor() {
		let scrollTop = 0;
		const handlers: (() => void)[] = [];
		// Line 2 wraps to three rows; everything else is one.
		const rows = (line: number) => (line === 2 ? 3 : 1);
		const topFor = (n: number) => {
			let top = 0;
			for (let i = 1; i < n; i++) top += rows(i) * 20;
			return top;
		};
		return {
			scrollTops: [] as number[],
			topFor,
			getModel: () => ({ getLineCount: () => 40 }),
			getTopForLineNumber: topFor,
			getScrollTop: () => scrollTop,
			setScrollTop(next: number) {
				scrollTop = next;
				(this as unknown as { scrollTops: number[] }).scrollTops.push(next);
			},
			onDidScrollChange(fn: () => void) {
				handlers.push(fn);
				return { dispose: () => handlers.splice(handlers.indexOf(fn), 1) };
			},
			scrollToLine(line: number) {
				scrollTop = topFor(line);
				for (const fn of handlers) fn();
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal editor stand-in
		} as any;
	}

	beforeEach(() => resetMergeScrollSync());

	it("lands on the right line when lines above have wrapped", () => {
		const result = wrappedEditor();
		const side = wrappedEditor();
		registerResultEditor("src", result);
		// Identity anchors: the two documents are the same here, so any drift is
		// the offset arithmetic's fault, not the mapping's.
		registerSideEditor("src", "side", side, [
			{ result: 1, side: 1 },
			{ result: 41, side: 41 },
		]);

		result.scrollToLine(6);
		// A uniform 20px height would compute (6-1)*20 = 100 and land on line 4.
		expect(side.scrollTops[side.scrollTops.length - 1]).toBe(side.topFor(6));
	});

	it("reads the top line back exactly across a wrap", () => {
		const result = wrappedEditor();
		const side = wrappedEditor();
		registerResultEditor("src", result);
		registerSideEditor("src", "side", side, [
			{ result: 1, side: 1 },
			{ result: 41, side: 41 },
		]);

		side.scrollToLine(9);
		expect(result.scrollTops[result.scrollTops.length - 1]).toBe(
			result.topFor(9),
		);
	});
});

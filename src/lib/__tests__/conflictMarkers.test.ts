import { describe, expect, it } from "vitest";
import {
	type ConflictBlock,
	parseConflicts,
	resolveAll,
	resolveBlock,
} from "../conflictMarkers";

const TWO_WAY = [
	"before",
	"<<<<<<< HEAD",
	"ours line",
	"=======",
	"theirs line",
	">>>>>>> feature/x",
	"after",
	"",
].join("\n");

const DIFF3 = [
	"<<<<<<< HEAD",
	"ours",
	"||||||| merged common ancestors",
	"base",
	"=======",
	"theirs",
	">>>>>>> other",
	"",
].join("\n");

const text = (b: ConflictBlock, src: string, part: "current" | "incoming") =>
	src.slice(b[part].startOffset, b[part].endOffset);

describe("parseConflicts", () => {
	it("parses a two-way block with labels and line numbers", () => {
		const [b] = parseConflicts(TWO_WAY);
		expect(b.index).toBe(0);
		expect(b.startLine).toBe(2);
		expect(b.endLine).toBe(6);
		expect(b.current.label).toBe("HEAD");
		expect(b.incoming.label).toBe("feature/x");
		expect(b.base).toBeNull();
		expect(text(b, TWO_WAY, "current")).toBe("ours line\n");
		expect(text(b, TWO_WAY, "incoming")).toBe("theirs line\n");
	});

	it("parses the diff3 ancestor region", () => {
		const [b] = parseConflicts(DIFF3);
		expect(b.base).not.toBeNull();
		expect(b.base?.label).toBe("merged common ancestors");
		expect(DIFF3.slice(b.base?.startOffset, b.base?.endOffset)).toBe("base\n");
		// The ancestor region must not leak into the current side.
		expect(text(b, DIFF3, "current")).toBe("ours\n");
	});

	it("numbers multiple blocks and keeps their ranges disjoint", () => {
		const src = TWO_WAY + TWO_WAY;
		const blocks = parseConflicts(src);
		expect(blocks.map((b) => b.index)).toEqual([0, 1]);
		expect(blocks[0].endOffset).toBeLessThanOrEqual(blocks[1].startOffset);
	});

	it("treats an empty current side as a zero-length range", () => {
		const src = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> x", ""].join(
			"\n",
		);
		const [b] = parseConflicts(src);
		expect(b.current.startLine).toBeGreaterThan(b.current.endLine);
		expect(b.current.startOffset).toBe(b.current.endOffset);
		expect(resolveBlock(src, b, "current")).toBe("");
	});

	it("accepts a block on the final line with no trailing newline", () => {
		const src = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x"].join("\n");
		const [b] = parseConflicts(src);
		expect(b).toBeDefined();
		expect(resolveBlock(src, b, "current")).toBe("a\n");
	});

	describe("malformed input yields nothing rather than a partial block", () => {
		it("ignores an unterminated opener", () => {
			expect(parseConflicts("<<<<<<< HEAD\nours\n=======\nmore\n")).toEqual([]);
		});

		it("ignores a separator with no opener, and still parses the next block", () => {
			const src = "=======\nstray\n" + TWO_WAY;
			const blocks = parseConflicts(src);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].index).toBe(0);
		});

		it("ignores a closer with no opener", () => {
			expect(parseConflicts(">>>>>>> x\n")).toEqual([]);
		});

		it("abandons the outer block when an opener nests", () => {
			const src = "<<<<<<< a\nx\n<<<<<<< b\ny\n=======\nz\n>>>>>>> c\n";
			const blocks = parseConflicts(src);
			// Only the inner, well-formed block survives.
			expect(blocks).toHaveLength(1);
			expect(blocks[0].startLine).toBe(3);
		});

		it("abandons on a second ancestor marker", () => {
			const src =
				"<<<<<<< a\nx\n||||||| p\nb\n||||||| q\nc\n=======\nz\n>>>>>>> c\n";
			expect(parseConflicts(src)).toEqual([]);
		});
	});

	describe("marker recognition matches git's rule exactly", () => {
		it("rejects eight chevrons", () => {
			const src = "<<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n";
			expect(parseConflicts(src)).toEqual([]);
		});

		it("rejects an indented marker", () => {
			const src = "  <<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n";
			expect(parseConflicts(src)).toEqual([]);
		});

		it("accepts a bare marker with no label", () => {
			const src = "<<<<<<<\na\n=======\nb\n>>>>>>>\n";
			const [b] = parseConflicts(src);
			expect(b).toBeDefined();
			expect(b.current.label).toBe("");
		});
	});
});

describe("resolveBlock", () => {
	it("keeps only the chosen side and drops every marker line", () => {
		const [b] = parseConflicts(TWO_WAY);
		expect(resolveBlock(TWO_WAY, b, "current")).toBe(
			"before\nours line\nafter\n",
		);
		expect(resolveBlock(TWO_WAY, b, "incoming")).toBe(
			"before\ntheirs line\nafter\n",
		);
	});

	it("keeps current before incoming for 'both'", () => {
		const [b] = parseConflicts(TWO_WAY);
		expect(resolveBlock(TWO_WAY, b, "both")).toBe(
			"before\nours line\ntheirs line\nafter\n",
		);
	});

	it("resolves to the ancestor under diff3", () => {
		const [b] = parseConflicts(DIFF3);
		expect(resolveBlock(DIFF3, b, "base")).toBe("base\n");
	});

	it("preserves CRLF exactly", () => {
		const crlf = TWO_WAY.replace(/\n/g, "\r\n");
		const [b] = parseConflicts(crlf);
		const out = resolveBlock(crlf, b, "current");
		expect(out).toBe("before\r\nours line\r\nafter\r\n");
		// No terminator was normalised in either direction.
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("preserves a mixed-EOL file byte-for-byte outside the block", () => {
		const src = "a\r\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\nb\r\n";
		const [b] = parseConflicts(src);
		expect(resolveBlock(src, b, "current")).toBe("a\r\nx\nb\r\n");
	});

	it("is idempotent: re-parsing yields one fewer block, correctly shifted", () => {
		const src = TWO_WAY + TWO_WAY;
		const before = parseConflicts(src);
		expect(before).toHaveLength(2);

		const out = resolveBlock(src, before[0], "current");
		const after = parseConflicts(out);
		expect(after).toHaveLength(1);
		expect(after[0].index).toBe(0);
		// The survivor moved up by the four marker+dropped lines removed above it.
		expect(after[0].startLine).toBe(before[1].startLine - 4);
	});
});

describe("resolveAll", () => {
	it("applies right-to-left so earlier offsets stay valid", () => {
		const src = TWO_WAY + TWO_WAY;
		expect(resolveAll(src, parseConflicts(src), "current")).toBe(
			"before\nours line\nafter\nbefore\nours line\nafter\n",
		);
	});

	it("is a no-op on a file with no conflicts", () => {
		const src = "just\nsome\ntext\n";
		expect(resolveAll(src, parseConflicts(src), "current")).toBe(src);
	});
});

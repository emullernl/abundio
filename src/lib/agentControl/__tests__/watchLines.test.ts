import { describe, expect, it } from "vitest";
import {
	compilePattern,
	EscapeStripper,
	hasNestedRepetition,
	LineMatcher,
	TEST_LINE_MAX,
} from "../watchLines";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("EscapeStripper", () => {
	it("drops colours, titles and cursor moves", () => {
		const s = new EscapeStripper();
		expect(
			s.feed(bytes("\x1b[32mready\x1b[0m in \x1b]0;title\x07300ms\x1b(B\r\n")),
		).toBe("ready in 300ms\r\n");
	});

	it("holds a sequence cut between chunks", () => {
		const s = new EscapeStripper();
		expect(s.feed(bytes("a\x1b[3"))).toBe("a");
		expect(s.feed(bytes("2mb"))).toBe("b");
		expect(s.feed(bytes("\x1b]0;t\x1b"))).toBe("");
		expect(s.feed(bytes("\\c"))).toBe("c");
	});

	it("keeps multi-byte characters split across chunks", () => {
		const s = new EscapeStripper();
		const all = bytes("é");
		expect(s.feed(all.slice(0, 1)) + s.feed(all.slice(1))).toBe("é");
	});
});

describe("LineMatcher", () => {
	it("matches a line split across chunks", () => {
		const m = new LineMatcher(/listening on \d+/);
		expect(m.feed("server listen")).toBeNull();
		expect(m.feed("ing on 30")).toBe("server listening on 30");
	});

	it("treats CR as a line end", () => {
		const m = new LineMatcher(/^done$/);
		expect(m.feed("50%\rdone\r")).toBe("done");
	});

	it("tests the open line, for prompts with no newline", () => {
		const m = new LineMatcher(/\? Continue/);
		expect(m.feed("? Continue (y/n) ")).toBe("? Continue (y/n) ");
	});

	it("ignores case only when asked", () => {
		expect(
			new LineMatcher(compilePattern("READY", false) as RegExp).feed("ready\n"),
		).toBeNull();
		expect(
			new LineMatcher(compilePattern("READY", true) as RegExp).feed("ready\n"),
		).toBe("ready");
	});

	it("refuses a broken pattern", () => {
		expect(compilePattern("(", false)).toBeNull();
	});
});

describe("hasNestedRepetition", () => {
	it.each([
		"(a+)+",
		"(a+)+$",
		"(\\w*\\s?)*",
		"((ab)*c)+",
		"(?:x+y){2,}",
		"(a*){1,5}",
	])("refuses %s", (p) => {
		expect(hasNestedRepetition(p)).toBe(true);
	});

	it.each([
		"READY",
		"^Listening on port \\d+",
		"(foo|bar)+",
		"(a+)?",
		"(a+){1}",
		"[(a+)]+",
		"\\(a+\\)+",
		"(\\d+)\\.(\\d+)",
	])("allows %s", (p) => {
		expect(hasNestedRepetition(p)).toBe(false);
	});
});

describe("LineMatcher input bound", () => {
	it("matches only the start of a very long line", () => {
		const long = `${"x".repeat(TEST_LINE_MAX)}END`;
		expect(
			new LineMatcher(compilePattern("END", false) as RegExp).feed(`${long}\n`),
		).toBeNull();
		expect(
			new LineMatcher(compilePattern("^x", false) as RegExp).feed(`${long}\n`),
		).toBe(long);
	});
});

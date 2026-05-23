import { describe, expect, it } from "vitest";
import {
	parseShellIntegration,
	ShellIntegrationParser,
} from "../shellIntegration";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseShellIntegration", () => {
	it("returns original data and empty commands when no sequences present", () => {
		const data = encode("hello world");
		const result = parseShellIntegration(data);
		expect(result.cleaned).toBe(data);
		expect(result.commands).toEqual([]);
	});

	it("parses command_start sequence without command text", () => {
		const data = encode("\x1b]7770;command_start\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
		]);
	});

	it("parses command_start with command text", () => {
		const data = encode("\x1b]7770;command_start;claude\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: "claude" },
		]);
	});

	it("parses command_start with full command line", () => {
		const data = encode("\x1b]7770;command_start;npx claude --model opus\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: "npx claude --model opus" },
		]);
	});

	it("parses command_end with exit code 0", () => {
		const data = encode("\x1b]7770;command_end;0\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([{ type: "command_end", exitCode: 0 }]);
	});

	it("parses command_end with non-zero exit code", () => {
		const data = encode("\x1b]7770;command_end;1\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([{ type: "command_end", exitCode: 1 }]);
	});

	it("parses multiple sequences in one chunk", () => {
		const data = encode(
			"\x1b]7770;command_start\x07\x1b]7770;command_end;0\x07",
		);
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
			{ type: "command_end", exitCode: 0 },
		]);
	});

	it("handles sequences interleaved with regular output", () => {
		const data = encode(
			"before\x1b]7770;command_start\x07middle\x1b]7770;command_end;42\x07after",
		);
		const result = parseShellIntegration(data);
		const cleanedStr = new TextDecoder().decode(result.cleaned);
		expect(cleanedStr).toBe("beforemiddleafter");
		expect(result.commands).toEqual([
			{ type: "command_start", commandText: undefined },
			{ type: "command_end", exitCode: 42 },
		]);
	});

	it("buffers a partial sequence at end of data so xterm never sees it", () => {
		// Regression for the "control characters flash, eat my typing"
		// symptom: the partial OSC must NOT be forwarded to xterm, otherwise
		// its OSC parser eats the bytes silently (good) OR they render as
		// text first if a prior CSI/OSC state was in some intermediate
		// state (bad). Hold them in residual instead.
		const data = encode("hello\x1b]7770;command_st");
		const result = parseShellIntegration(data);
		const cleanedStr = new TextDecoder().decode(result.cleaned);
		expect(cleanedStr).toBe("hello");
		expect(result.commands).toEqual([]);
	});

	it("parses cwd_change sequence", () => {
		const data = encode("\x1b]7770;cwd;/Users/foo/bar\x07");
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "cwd_change", path: "/Users/foo/bar" },
		]);
	});

	it("parses cwd_change interleaved with other sequences", () => {
		const data = encode(
			"\x1b]7770;command_end;0\x07\x1b]7770;cwd;/home/user/project\x07",
		);
		const result = parseShellIntegration(data);
		expect(result.cleaned.length).toBe(0);
		expect(result.commands).toEqual([
			{ type: "command_end", exitCode: 0 },
			{ type: "cwd_change", path: "/home/user/project" },
		]);
	});
});

// Stateful parser — what the production code holds per PTY. Covers the
// chunk-boundary cases that the stateless wrapper can't.

describe("ShellIntegrationParser (chunk reassembly)", () => {
	it("reassembles a sequence split across two chunks", () => {
		const parser = new ShellIntegrationParser();
		const r1 = parser.parse(encode("prompt\x1b]7770;cwd;/Users/me/"));
		expect(new TextDecoder().decode(r1.cleaned)).toBe("prompt");
		expect(r1.commands).toEqual([]);
		const r2 = parser.parse(encode("project\x07after"));
		expect(new TextDecoder().decode(r2.cleaned)).toBe("after");
		expect(r2.commands).toEqual([
			{ type: "cwd_change", path: "/Users/me/project" },
		]);
	});

	it("buffers a chunk that ends mid-prefix (`\\x1b]77`)", () => {
		// The pathological case for the OLD parser: chunk ends inside the
		// `]7770;` prefix, so the prefix check fails for "no match" and the
		// partial bytes were forwarded to xterm.
		const parser = new ShellIntegrationParser();
		const r1 = parser.parse(encode("hello\x1b]77"));
		expect(new TextDecoder().decode(r1.cleaned)).toBe("hello");
		expect(r1.commands).toEqual([]);
		const r2 = parser.parse(encode("70;command_end;0\x07"));
		expect(r2.cleaned.length).toBe(0);
		expect(r2.commands).toEqual([{ type: "command_end", exitCode: 0 }]);
	});

	it("buffers a lone trailing ESC", () => {
		const parser = new ShellIntegrationParser();
		const r1 = parser.parse(encode("text\x1b"));
		expect(new TextDecoder().decode(r1.cleaned)).toBe("text");
		// The next chunk reveals the ESC was the start of an OSC we don't care
		// about — pass it through to xterm.
		const r2 = parser.parse(encode("[2J"));
		expect(new TextDecoder().decode(r2.cleaned)).toBe("\x1b[2J");
		expect(r2.commands).toEqual([]);
	});

	it("forwards non-7770 OSC sequences to xterm untouched", () => {
		const parser = new ShellIntegrationParser();
		// OSC 0 ; title \x07 — xterm window-title set. We must NOT eat it.
		const data = encode("\x1b]0;my title\x07");
		const r = parser.parse(data);
		expect(new TextDecoder().decode(r.cleaned)).toBe("\x1b]0;my title\x07");
		expect(r.commands).toEqual([]);
	});

	it("eventually flushes a misframed sequence that never terminates", () => {
		const parser = new ShellIntegrationParser();
		// A genuine `\x1b]7770;` start followed by an arbitrarily long stream
		// of bytes without BEL would otherwise wedge the parser. Once the
		// buffered residual exceeds the cap, we give up and let it through.
		const huge = "x".repeat(20 * 1024);
		const r = parser.parse(encode(`\x1b]7770;${huge}`));
		// `cleaned` ends up empty here because we hold the partial in residual
		// until the cap is hit on this single call. The important guarantee
		// is that subsequent input still flows once the residual flushes.
		const r2 = parser.parse(encode("hello"));
		// At this point the residual was capped, the partial was let through,
		// and `hello` made it out.
		expect(new TextDecoder().decode(r2.cleaned)).toContain("hello");
		expect([...r.commands, ...r2.commands]).toEqual([]);
	});
});

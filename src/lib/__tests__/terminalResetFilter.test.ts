import { describe, expect, it } from "vitest";
import { stripResetSequences } from "../terminalResetFilter";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("stripResetSequences", () => {
	it("returns original reference when no ESC bytes present", () => {
		const data = encode("hello world");
		const result = stripResetSequences(data);
		expect(result).toBe(data);
	});

	it("returns original reference for empty input", () => {
		const data = new Uint8Array(0);
		const result = stripResetSequences(data);
		expect(result).toBe(data);
	});

	it("strips ESC c (RIS)", () => {
		const data = encode("\x1bc");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips ESC [ 2 J (ED 2 — erase display)", () => {
		const data = encode("\x1b[2J");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips ESC [ 3 J (ED 3 — erase scrollback)", () => {
		const data = encode("\x1b[3J");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips all reset/clear/home sequences in a row", () => {
		const data = encode("\x1bc\x1b[H\x1b[2J\x1b[3J");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips reset interleaved with normal output", () => {
		const data = encode("hello\x1bcworld");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("helloworld");
	});

	it("strips ED sequences interleaved with normal output", () => {
		const data = encode("before\x1b[2Jmiddle\x1b[3Jafter");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("beforemiddleafter");
	});

	it("preserves ESC at end of buffer (partial sequence)", () => {
		const data = encode("hello\x1b");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("hello\x1b");
	});

	it("preserves ESC [ at end of buffer (partial CSI)", () => {
		const data = encode("hello\x1b[");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("hello\x1b[");
	});

	it("preserves ESC followed by non-reset byte", () => {
		const data = encode("\x1b[0m");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("\x1b[0m");
	});

	it("preserves similar but different ED sequences (ESC [ 1 J, ESC [ 0 J)", () => {
		const data = encode("\x1b[1J\x1b[0J");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("\x1b[1J\x1b[0J");
	});

	it("preserves other ESC sequences like SGR", () => {
		const data = encode("\x1b[1;32mgreen\x1b[0m");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("\x1b[1;32mgreen\x1b[0m");
	});

	it("strips ESC [ H (cursor home)", () => {
		const data = encode("\x1b[H");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips ESC [ ; H (cursor home variant)", () => {
		const data = encode("\x1b[;H");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("strips typical clear+home combo", () => {
		const data = encode("\x1b[2J\x1b[Huser@host:~$ ");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("user@host:~$ ");
	});

	it("strips explicit home CUP variants (1H, 1;1H, ;1H, ;, 1;)", () => {
		const variants = [
			"\x1b[1H",
			"\x1b[1;1H",
			"\x1b[;1H",
			"\x1b[;H",
			"\x1b[1;H",
		];
		for (const v of variants) {
			const result = stripResetSequences(encode(v));
			expect(result.length, `variant: ${JSON.stringify(v)}`).toBe(0);
		}
	});

	it("strips HVP home variants (ESC [ ... f)", () => {
		expect(stripResetSequences(encode("\x1b[f")).length).toBe(0);
		expect(stripResetSequences(encode("\x1b[1;1f")).length).toBe(0);
	});

	it("preserves non-home parameterized CUP (shell cursor positioning)", () => {
		// PowerShell / ConPTY use these when repainting the screen row by row
		// on resize. Stripping them collapses the shell's paint into one row.
		const data = encode("\x1b[30;1H\x1b[10;20H\x1b[2;5Hhi");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe(
			"\x1b[30;1H\x1b[10;20H\x1b[2;5Hhi",
		);
	});

	it("preserves non-home HVP", () => {
		const data = encode("\x1b[5;10f");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("\x1b[5;10f");
	});

	it("handles reset at the very end of output", () => {
		const data = encode("some output\x1b[3J");
		const result = stripResetSequences(data);
		expect(new TextDecoder().decode(result)).toBe("some output");
	});

	it("strips runs of 3+ CRLF (ConPTY viewport padding)", () => {
		const data = encode("\r\n\r\n\r\n\r\n\r\n");
		const result = stripResetSequences(data);
		expect(result.length).toBe(0);
	});

	it("preserves single and double CRLF (legit blank lines)", () => {
		const single = encode("line1\r\nline2");
		expect(new TextDecoder().decode(stripResetSequences(single))).toBe(
			"line1\r\nline2",
		);
		const dbl = encode("para1\r\n\r\npara2");
		expect(new TextDecoder().decode(stripResetSequences(dbl))).toBe(
			"para1\r\n\r\npara2",
		);
	});

	it("strips the full Git Bash / ConPTY startup paint block", () => {
		// Actual bytes observed on Windows: hide cursor, ED 2, SGR, home,
		// 33 × CRLF padding, home, OSC title, show cursor.
		const padding = "\r\n".repeat(33);
		const data = encode(
			`\x1b[?25l\x1b[2J\x1b[m\x1b[H${padding}\x1b[H\x1b]0;title\x07\x1b[?25h`,
		);
		const result = stripResetSequences(data);
		// The 33×CRLF block is gone; only the non-stripped control bits remain.
		expect(new TextDecoder().decode(result)).toBe(
			"\x1b[?25l\x1b[m\x1b]0;title\x07\x1b[?25h",
		);
	});
});

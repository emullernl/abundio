import { describe, expect, it } from "vitest";
import {
	alternateScreenBefore,
	isAlternateScreenOutput,
	scanAlternateScreen,
	shouldStripResets,
	stripResetSequences,
} from "../terminalResetFilter";

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

describe("shouldStripResets", () => {
	const cases: [boolean, boolean, boolean, boolean][] = [
		// agentMode, alternateScreen, awaitingAgentStart, expected
		[false, false, false, true],
		[true, false, false, false],
		[false, true, false, false],
		[true, true, false, false],
		[true, false, true, true],
		[true, true, true, false],
		[false, false, true, true],
	];

	it.each(
		cases,
	)("agentMode=%s alternateScreen=%s awaitingAgentStart=%s -> %s", (agentMode, alternateScreen, awaitingAgentStart, expected) => {
		expect(
			shouldStripResets({ agentMode, alternateScreen, awaitingAgentStart }),
		).toBe(expected);
	});
});

describe("scanAlternateScreen", () => {
	it("leaves the state alone when there is no switch", () => {
		expect(scanAlternateScreen(encode("\x1b[H\x1b[2Jhi"), false)).toEqual({
			after: false,
			entered: false,
		});
		expect(scanAlternateScreen(encode("hi"), true)).toEqual({
			after: true,
			entered: false,
		});
	});

	it.each(["47", "1047", "1049"])("detects ?%sh and ?%sl", (mode) => {
		expect(scanAlternateScreen(encode(`\x1b[?${mode}h`), false)).toEqual({
			after: true,
			entered: true,
		});
		expect(scanAlternateScreen(encode(`\x1b[?${mode}l`), true)).toEqual({
			after: false,
			entered: false,
		});
	});

	it("detects the mode among other params", () => {
		expect(scanAlternateScreen(encode("\x1b[?1002;1049h"), false).after).toBe(
			true,
		);
		expect(scanAlternateScreen(encode("\x1b[?1049;1002h"), false).after).toBe(
			true,
		);
	});

	it("ignores other private modes and non-private CSIs", () => {
		expect(
			scanAlternateScreen(encode("\x1b[?25h\x1b[?10490h"), false).after,
		).toBe(false);
		expect(scanAlternateScreen(encode("\x1b[1049h"), false).after).toBe(false);
	});

	it("uses the last switch for the final state, but reports any entry", () => {
		expect(
			scanAlternateScreen(encode("\x1b[?1049hframe\x1b[?1049l"), false),
		).toEqual({ after: false, entered: true });
	});

	it("still sees a switch right after a truncated sequence", () => {
		expect(scanAlternateScreen(encode("\x1b[?1049\x1b[?1049h"), false)).toEqual(
			{ after: true, entered: true },
		);
	});

	it("ignores a sequence cut off at the end of the chunk", () => {
		expect(scanAlternateScreen(encode("\x1b[?1049"), false).after).toBe(false);
	});
});

describe("alternateScreenBefore", () => {
	it("uses xterm's buffer type when nothing is queued", () => {
		expect(
			alternateScreenBefore({
				queueEmpty: true,
				bufferIsAlternate: true,
				queued: false,
			}),
		).toBe(true);
		expect(
			alternateScreenBefore({
				queueEmpty: true,
				bufferIsAlternate: false,
				queued: true,
			}),
		).toBe(false);
	});

	it("uses the queued state when bytes are waiting for the next frame", () => {
		expect(
			alternateScreenBefore({
				queueEmpty: false,
				bufferIsAlternate: false,
				queued: true,
			}),
		).toBe(true);
		expect(
			alternateScreenBefore({
				queueEmpty: false,
				bufferIsAlternate: true,
				queued: false,
			}),
		).toBe(false);
	});

	it("tracks a queue incrementally, one scan per chunk", () => {
		// Mirrors scheduleWrite: each queued chunk folds into the state once.
		const chunks = ["out", "\x1b[?1049h", "frame", "\x1b[?1049l", "\x1b[?47h"];
		let queued = false;
		let queueEmpty = true;
		const seen: boolean[] = [];
		for (const c of chunks) {
			const before = alternateScreenBefore({
				queueEmpty,
				bufferIsAlternate: false,
				queued,
			});
			seen.push(before);
			queued = scanAlternateScreen(encode(c), before).after;
			queueEmpty = false;
		}
		expect(seen).toEqual([false, false, true, true, false]);
		expect(queued).toBe(true);
	});
});

describe("isAlternateScreenOutput", () => {
	const frame = encode("\x1b[H\x1b[2Jframe");

	it("is true when the screen is already alternate", () => {
		expect(isAlternateScreenOutput(true, frame)).toBe(true);
	});

	it("is false on the normal screen", () => {
		expect(isAlternateScreenOutput(false, frame)).toBe(false);
	});

	it("sees a switch inside the chunk itself", () => {
		expect(
			isAlternateScreenOutput(false, encode("\x1b[?1049h\x1b[H\x1b[2J")),
		).toBe(true);
	});
});

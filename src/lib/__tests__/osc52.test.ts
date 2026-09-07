import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, parseOsc52 } from "../osc52";

/** `btoa` over UTF-8 bytes, the way a program encodes an OSC 52 payload. */
function b64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

/** Live output — the ordinary case. */
const live = { restoring: false };

describe("parseOsc52", () => {
	it("writes what the program copied", () => {
		expect(parseOsc52(`c;${b64("hello")}`, live)).toEqual({
			kind: "write",
			text: "hello",
		});
	});

	it("accepts an empty target list, which means the default", () => {
		expect(parseOsc52(`;${b64("hi")}`, live)).toEqual({
			kind: "write",
			text: "hi",
		});
	});

	it("round-trips text that is not ASCII", () => {
		const text = "héllo — 世界 🎉";
		expect(parseOsc52(`c;${b64(text)}`, live)).toEqual({ kind: "write", text });
	});

	it("treats an empty payload as clearing the clipboard", () => {
		expect(parseOsc52("c;", live)).toEqual({ kind: "write", text: "" });
	});

	// `Pd` of `?` asks the terminal to send the clipboard BACK to the program as
	// an input sequence, which would make any program — or any file someone cats
	// — a clipboard exfiltration channel. Not implemented at all, so there is no
	// setting to get wrong.
	it("refuses to read the clipboard back to the program", () => {
		expect(parseOsc52("c;?", live)).toEqual({
			kind: "ignore",
			reason: "read-refused",
		});
	});

	// PRIMARY is the X11 middle-click selection, a different thing from the
	// clipboard. Honouring it would let every mouse selection inside a TUI
	// silently replace what the user actually copied.
	it("ignores a write aimed only at the primary selection", () => {
		expect(parseOsc52(`p;${b64("nope")}`, live)).toEqual({
			kind: "ignore",
			reason: "primary-only",
		});
	});

	it("still writes when the clipboard is among several targets", () => {
		expect(parseOsc52(`pc;${b64("yes")}`, live)).toEqual({
			kind: "write",
			text: "yes",
		});
	});

	// Replayed scrollback carries a finished session's OSC 52s, which would
	// replace today's clipboard with yesterday's copy at app start.
	describe("while replaying scrollback", () => {
		const restoring = { restoring: true };

		it("ignores a write", () => {
			expect(parseOsc52(`c;${b64("stale")}`, restoring)).toEqual({
				kind: "ignore",
				reason: "restoring",
			});
		});

		// Deliberately the bare `restoring`, unlike the mouse hooks'
		// `restoring && !restoreIsLive`: a live PTY's log is no better here,
		// because the program already got its write when those bytes were first
		// produced, and replaying it would write twice.
		it("ignores it whatever the replay is of", () => {
			expect(parseOsc52("c;?", restoring)).toEqual({
				kind: "ignore",
				reason: "restoring",
			});
		});
	});

	// A bare CR executes on paste into any shell not in bracketed-paste mode,
	// and the clipboard is system-wide — the next paste need not be into Abundio.
	describe("neutralises control characters", () => {
		it("turns a bare CR into a newline rather than leaving it to execute", () => {
			expect(parseOsc52(`c;${b64("git status\rrm -rf ~\r")}`, live)).toEqual({
				kind: "write",
				text: "git status\nrm -rf ~\n",
			});
		});

		it("collapses CRLF to a single newline", () => {
			expect(parseOsc52(`c;${b64("a\r\nb")}`, live)).toEqual({
				kind: "write",
				text: "a\nb",
			});
		});

		it("keeps the two controls a copied snippet actually needs", () => {
			expect(parseOsc52(`c;${b64("a\tb\nc")}`, live)).toEqual({
				kind: "write",
				text: "a\tb\nc",
			});
		});

		it("strips the rest, including ESC and DEL", () => {
			expect(parseOsc52(`c;${b64("a\x1b[31mb\x07c\x7f")}`, live)).toEqual({
				kind: "write",
				text: "a[31mbc",
			});
		});
	});

	describe("rejects what it cannot trust", () => {
		it("a payload with no separator", () => {
			expect(parseOsc52("garbage", live)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("a payload that is not base64", () => {
			expect(parseOsc52("c;not base64!!", live)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("base64 of the wrong length", () => {
			expect(parseOsc52("c;YWJjZA", live)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("bytes that are not valid UTF-8", () => {
			// 0xFF is not a legal UTF-8 lead byte.
			expect(parseOsc52("c;/w==", live)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		// A clipboard write is a side effect on the user's whole desktop, and the
		// payload arrives as ordinary terminal output. Both boundary cases use a
		// length that is a multiple of 4, so they clear the well-formedness checks
		// and the cap is the only thing that can decide them — the previous version
		// of this test did not, and passed green with OSC52_MAX_BYTES deleted.
		it("a payload past the size cap", () => {
			const over = "A".repeat(Math.ceil(OSC52_MAX_BYTES / 3) * 4 + 4);
			expect(parseOsc52(`c;${over}`, live)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("but not one just under it", () => {
			const under = "A".repeat(Math.floor(OSC52_MAX_BYTES / 3) * 4);
			expect(parseOsc52(`c;${under}`, live).kind).toBe("write");
		});
	});
});

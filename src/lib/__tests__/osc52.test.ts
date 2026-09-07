import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, parseOsc52 } from "../osc52";

/** `btoa` over UTF-8 bytes, the way a program encodes an OSC 52 payload. */
function b64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

describe("parseOsc52", () => {
	it("writes what the program copied", () => {
		expect(parseOsc52(`c;${b64("hello")}`)).toEqual({
			kind: "write",
			text: "hello",
		});
	});

	it("accepts an empty target list, which means the default", () => {
		expect(parseOsc52(`;${b64("hi")}`)).toEqual({ kind: "write", text: "hi" });
	});

	it("round-trips text that is not ASCII", () => {
		const text = "héllo — 世界 🎉";
		expect(parseOsc52(`c;${b64(text)}`)).toEqual({ kind: "write", text });
	});

	it("treats an empty payload as clearing the clipboard", () => {
		expect(parseOsc52("c;")).toEqual({ kind: "write", text: "" });
	});

	// `Pd` of `?` asks the terminal to send the clipboard BACK to the program as
	// an input sequence, which would make any program — or any file someone cats
	// — a clipboard exfiltration channel. Not implemented at all, so there is no
	// setting to get wrong.
	it("refuses to read the clipboard back to the program", () => {
		expect(parseOsc52("c;?")).toEqual({
			kind: "ignore",
			reason: "read-refused",
		});
	});

	// PRIMARY is the X11 middle-click selection, a different thing from the
	// clipboard. Honouring it would let every mouse selection inside a TUI
	// silently replace what the user actually copied.
	it("ignores a write aimed only at the primary selection", () => {
		expect(parseOsc52(`p;${b64("nope")}`)).toEqual({
			kind: "ignore",
			reason: "primary-only",
		});
	});

	it("still writes when the clipboard is among several targets", () => {
		expect(parseOsc52(`pc;${b64("yes")}`)).toEqual({
			kind: "write",
			text: "yes",
		});
	});

	describe("rejects what it cannot trust", () => {
		it("a payload with no separator", () => {
			expect(parseOsc52("garbage")).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("a payload that is not base64", () => {
			expect(parseOsc52("c;not base64!!")).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("base64 of the wrong length", () => {
			expect(parseOsc52("c;YWJjZA")).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		// A clipboard write is a side effect on the user's whole desktop, and the
		// payload arrives as ordinary terminal output.
		it("a payload past the size cap", () => {
			const huge = "A".repeat(Math.ceil((OSC52_MAX_BYTES / 3) * 4) + 4);
			expect(parseOsc52(`c;${huge}`)).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});

		it("bytes that are not valid UTF-8", () => {
			// 0xFF is not a legal UTF-8 lead byte.
			expect(parseOsc52("c;/w==")).toEqual({
				kind: "ignore",
				reason: "rejected",
			});
		});
	});
});

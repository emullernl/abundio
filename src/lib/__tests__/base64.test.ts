import { describe, expect, it } from "vitest";
import { decodeBase64 } from "../base64";

/** Reference decoder using the old atob + charCodeAt pattern. */
function decodeBase64Reference(str: string): Uint8Array {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

describe("decodeBase64", () => {
	it("decodes an empty string", () => {
		expect(decodeBase64("")).toEqual(new Uint8Array(0));
	});

	it("decodes ASCII text", () => {
		const encoded = btoa("Hello, World!");
		expect(decodeBase64(encoded)).toEqual(decodeBase64Reference(encoded));
	});

	it("decodes data with 1-byte padding", () => {
		// "ab" → "YWI=" (1 pad char)
		const encoded = btoa("ab");
		expect(decodeBase64(encoded)).toEqual(decodeBase64Reference(encoded));
	});

	it("decodes data with 2-byte padding", () => {
		// "a" → "YQ==" (2 pad chars)
		const encoded = btoa("a");
		expect(decodeBase64(encoded)).toEqual(decodeBase64Reference(encoded));
	});

	it("decodes data with no padding", () => {
		// "abc" → "YWJj" (0 pad chars)
		const encoded = btoa("abc");
		expect(decodeBase64(encoded)).toEqual(decodeBase64Reference(encoded));
	});

	it("handles binary data with bytes > 0x7F", () => {
		// Build a string with all byte values 0x00–0xFF
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i;
		const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
		const encoded = btoa(binaryStr);

		const result = decodeBase64(encoded);
		expect(result).toEqual(bytes);
		expect(result).toEqual(decodeBase64Reference(encoded));
	});

	it("handles a large payload", () => {
		const size = 65536;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
		const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
		const encoded = btoa(binaryStr);

		const result = decodeBase64(encoded);
		expect(result.length).toBe(size);
		expect(result).toEqual(decodeBase64Reference(encoded));
	});
});

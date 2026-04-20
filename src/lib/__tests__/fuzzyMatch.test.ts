import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyMatchFile } from "../fuzzyMatch";

describe("fuzzyMatch", () => {
	it("empty query matches everything with score 1", () => {
		expect(fuzzyMatch("", "anything")).toBe(1);
	});

	it("exact substring beats subsequence match", () => {
		const substring = fuzzyMatch("read", "README.md");
		const subsequence = fuzzyMatch("read", "risk-even-alarm-does");
		expect(substring).toBeGreaterThan(subsequence);
	});

	it("returns 0 when characters cannot be matched in order", () => {
		expect(fuzzyMatch("xyz", "abc")).toBe(0);
	});

	it("is case-insensitive", () => {
		expect(fuzzyMatch("readme", "README.md")).toBeGreaterThan(0);
	});
});

describe("fuzzyMatchFile", () => {
	it("basename match outranks path-only match", () => {
		const basenameHit = fuzzyMatchFile("readme", "docs/README.md");
		const pathHit = fuzzyMatchFile("readme", "readme-notes/other.txt");
		expect(basenameHit).toBeGreaterThan(pathHit);
	});

	it("returns 0 when query cannot be matched anywhere", () => {
		expect(fuzzyMatchFile("zzz", "src/app.tsx")).toBe(0);
	});

	it("handles bare filenames (no directory)", () => {
		expect(fuzzyMatchFile("app", "App.tsx")).toBeGreaterThan(0);
	});

	it("prefers exact basename over partial path substring", () => {
		const exact = fuzzyMatchFile("config.ts", "src/config.ts");
		const partial = fuzzyMatchFile("config.ts", "src/configuration/other.ts");
		expect(exact).toBeGreaterThan(partial);
	});
});

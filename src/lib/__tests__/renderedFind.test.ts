import { describe, expect, it } from "vitest";
import { findMatches, findRanges } from "../renderedFind";

describe("findMatches", () => {
	it("finds every case-insensitive match without overlap", () => {
		expect(findMatches("Abc abc ABC", "abc")).toEqual([
			[0, 3],
			[4, 7],
			[8, 11],
		]);
		expect(findMatches("aaaa", "aa")).toEqual([
			[0, 2],
			[2, 4],
		]);
	});

	it("returns nothing for an empty query or no match", () => {
		expect(findMatches("text", "")).toEqual([]);
		expect(findMatches("text", "zz")).toEqual([]);
	});
});

describe("findRanges", () => {
	it("returns a range per match across text nodes", () => {
		const root = document.createElement("div");
		root.innerHTML =
			"<h1>Install</h1><p>Run install, then <em>install</em> again.</p>";
		const ranges = findRanges(root, "install");
		expect(ranges).toHaveLength(3);
		expect(ranges.map((r) => r.toString())).toEqual([
			"Install",
			"install",
			"install",
		]);
	});
});

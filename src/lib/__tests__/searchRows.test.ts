import { describe, expect, it } from "vitest";
import { flattenSearchRows } from "../searchRows";
import type { SearchFileResult } from "../types";

const match = (lineNumber: number) => ({
	lineNumber,
	lineContent: "hit",
	matchStart: 0,
	matchEnd: 3,
});

const file = (filePath: string, lines: number[]): SearchFileResult => ({
	filePath,
	matches: lines.map(match),
});

describe("flattenSearchRows", () => {
	it("emits a file row followed by its match rows in order", () => {
		const rows = flattenSearchRows([file("/a.ts", [1, 2])], {});

		expect(rows.map((r) => r.kind)).toEqual(["file", "match", "match"]);
		expect(rows[0]).toMatchObject({ kind: "file" });
		expect(rows[1]).toMatchObject({ kind: "match", filePath: "/a.ts" });
	});

	it("omits match rows for collapsed files but keeps the header", () => {
		const rows = flattenSearchRows(
			[file("/a.ts", [1, 2]), file("/b.ts", [5])],
			{ "/a.ts": true },
		);

		// /a.ts collapsed -> header only; /b.ts expanded -> header + 1 match.
		expect(rows.map((r) => r.kind)).toEqual(["file", "file", "match"]);
		expect(rows[2]).toMatchObject({ kind: "match", filePath: "/b.ts" });
	});

	it("produces stable, unique keys per row", () => {
		const rows = flattenSearchRows([file("/a.ts", [1, 2])], {});
		const keys = rows.map((r) => r.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys[0]).toBe("f:/a.ts");
	});

	it("returns an empty list when there are no files", () => {
		expect(flattenSearchRows([], {})).toEqual([]);
	});
});

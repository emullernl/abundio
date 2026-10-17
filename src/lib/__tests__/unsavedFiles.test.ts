import { describe, expect, it } from "vitest";
import { unsavedFilePaths } from "../unsavedFiles";

describe("unsavedFilePaths", () => {
	it("lists dirty panes once each, sorted", () => {
		expect(
			unsavedFilePaths({
				a: { filePath: "/r/b.md", isDirty: true },
				b: { filePath: "/r/a.ts", isDirty: true },
				c: { filePath: "/r/b.md", isDirty: true },
				d: { filePath: "/r/c.ts", isDirty: false },
			}),
		).toEqual(["/r/a.ts", "/r/b.md"]);
	});

	it("is empty when nothing is unsaved", () => {
		expect(unsavedFilePaths({})).toEqual([]);
	});
});

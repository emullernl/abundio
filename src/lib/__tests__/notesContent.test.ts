import { describe, expect, it } from "vitest";
import { isEmptyNoteContent, parseNoteContent } from "../notesContent";

describe("isEmptyNoteContent", () => {
	it("treats empty string and whitespace as empty", () => {
		expect(isEmptyNoteContent("")).toBe(true);
		expect(isEmptyNoteContent("   ")).toBe(true);
		expect(isEmptyNoteContent(null)).toBe(true);
		expect(isEmptyNoteContent(undefined)).toBe(true);
	});

	it("treats a lone empty paragraph as empty", () => {
		expect(
			isEmptyNoteContent(
				JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
			),
		).toBe(true);
	});

	it("treats invalid JSON as empty", () => {
		expect(isEmptyNoteContent("{not json")).toBe(true);
	});

	it("treats a paragraph with text as non-empty", () => {
		const doc = {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
		};
		expect(isEmptyNoteContent(JSON.stringify(doc))).toBe(false);
	});

	it("treats a checklist as non-empty", () => {
		const doc = {
			type: "doc",
			content: [{ type: "taskList", content: [{ type: "taskItem" }] }],
		};
		expect(isEmptyNoteContent(JSON.stringify(doc))).toBe(false);
	});
});

describe("parseNoteContent", () => {
	it("returns an empty doc for empty input", () => {
		expect(parseNoteContent("")).toEqual({
			type: "doc",
			content: [{ type: "paragraph" }],
		});
	});

	it("returns an empty doc for invalid JSON", () => {
		expect(parseNoteContent("{broken")).toEqual({
			type: "doc",
			content: [{ type: "paragraph" }],
		});
	});

	it("round-trips a valid document", () => {
		const doc = {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "note" }] },
			],
		};
		expect(parseNoteContent(JSON.stringify(doc))).toEqual(doc);
	});
});

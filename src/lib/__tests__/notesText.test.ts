import { describe, expect, it } from "vitest";
import {
	appendToDoc,
	type DocNode,
	noteToText,
	textToNodes,
} from "../notesText";

const t = (text: string, ...marks: string[]) => ({
	type: "text",
	text,
	...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const p = (...content: object[]): DocNode => ({
	type: "paragraph",
	content: content as DocNode[],
});

describe("noteToText", () => {
	it("writes paragraphs, marks, bullets and nested task items", () => {
		const doc = {
			type: "doc",
			content: [
				p(t("Plan "), t("now", "bold"), t(" or "), t("later", "italic")),
				p(t("old", "strike"), { type: "hardBreak" }, t("next line")),
				{
					type: "bulletList",
					content: [{ type: "listItem", content: [p(t("a bullet"))] }],
				},
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [
								p(t("done")),
								{
									type: "taskList",
									content: [
										{
											type: "taskItem",
											attrs: { checked: false },
											content: [p(t("sub"))],
										},
									],
								},
							],
						},
					],
				},
			],
		};
		expect(noteToText(doc)).toBe(
			[
				"Plan **now** or *later*",
				"~~old~~",
				"next line",
				"- a bullet",
				"- [x] done",
				"  - [ ] sub",
			].join("\n"),
		);
	});

	it("is empty for no note or a broken one", () => {
		expect(noteToText(null)).toBe("");
		expect(noteToText({ type: "doc" })).toBe("");
	});
});

describe("textToNodes", () => {
	it("signs the first paragraph and groups list lines", () => {
		expect(
			textToNodes("Auth done\n\n- [ ] tests\n- [x] docs\n- note", "Agent Two"),
		).toEqual([
			p(t("Agent Two:", "bold"), t(" "), t("Auth done")),
			{
				type: "taskList",
				content: [
					{
						type: "taskItem",
						attrs: { checked: false },
						content: [p(t("tests"))],
					},
					{
						type: "taskItem",
						attrs: { checked: true },
						content: [p(t("docs"))],
					},
				],
			},
			{
				type: "bulletList",
				content: [{ type: "listItem", content: [p(t("note"))] }],
			},
		]);
	});

	it("puts the byline on its own line when the text starts with a list", () => {
		const nodes = textToNodes("- [ ] one", "p2");
		expect(nodes[0]).toEqual(p(t("p2:", "bold")));
		expect(nodes[1].type).toBe("taskList");
	});
});

describe("appendToDoc", () => {
	const add = [p(t("new"))];
	it("adds at the end", () => {
		const doc = { type: "doc", content: [p(t("old"))] };
		expect(appendToDoc(doc, add).content).toEqual([p(t("old")), p(t("new"))]);
	});
	it("replaces an empty note instead of keeping a blank line", () => {
		expect(
			appendToDoc({ type: "doc", content: [{ type: "paragraph" }] }, add)
				.content,
		).toEqual(add);
		expect(appendToDoc(null, add).content).toEqual(add);
	});
});

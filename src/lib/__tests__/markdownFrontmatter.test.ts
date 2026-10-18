import rehypeSanitize from "rehype-sanitize";
import { describe, expect, it } from "vitest";
import {
	frontmatterView,
	remarkFrontmatterTable,
} from "../markdownFrontmatter";
import { markdownSanitizeSchema } from "../markdownSanitizeSchema";

describe("frontmatterView", () => {
	it("turns a flat mapping into rows, in source order", () => {
		expect(frontmatterView("title: Hello\ndraft: true\ncount: 3")).toEqual({
			kind: "table",
			rows: [
				{ key: "title", value: "Hello", block: false },
				{ key: "draft", value: "true", block: false },
				{ key: "count", value: "3", block: false },
			],
		});
	});

	it("keeps integer-like keys in source order", () => {
		const view = frontmatterView("title: Notes\n2024: shipped\n1: first");
		expect(view.kind === "table" && view.rows.map((r) => r.key)).toEqual([
			"title",
			"2024",
			"1",
		]);
	});

	it("keeps a block scalar's line breaks", () => {
		expect(frontmatterView("description: |\n  Line one\n  Line two")).toEqual({
			kind: "table",
			rows: [{ key: "description", value: "Line one\nLine two", block: false }],
		});
	});

	it("does not promote a title key", () => {
		const view = frontmatterView("title: Hello");
		expect(view).toEqual({
			kind: "table",
			rows: [{ key: "title", value: "Hello", block: false }],
		});
	});

	it("shows a null value as an empty cell", () => {
		expect(frontmatterView("author:")).toEqual({
			kind: "table",
			rows: [{ key: "author", value: "", block: false }],
		});
	});

	it("joins a list of scalars with commas", () => {
		expect(frontmatterView("tags: [a, b, 3]")).toEqual({
			kind: "table",
			rows: [{ key: "tags", value: "a, b, 3", block: false }],
		});
	});

	it("shows a nested mapping as its YAML text", () => {
		expect(frontmatterView("seo:\n  title: X\n  noindex: true")).toEqual({
			kind: "table",
			rows: [{ key: "seo", value: "title: X\nnoindex: true", block: true }],
		});
	});

	it("shows a list holding a mapping as YAML text", () => {
		const view = frontmatterView("authors:\n  - name: A");
		expect(view).toEqual({
			kind: "table",
			rows: [{ key: "authors", value: "- name: A", block: true }],
		});
	});

	it("is empty for an empty or comment-only block", () => {
		expect(frontmatterView("")).toEqual({ kind: "empty" });
		expect(frontmatterView("# just a note")).toEqual({ kind: "empty" });
		expect(frontmatterView("{}")).toEqual({ kind: "empty" });
	});

	it("falls back to raw for invalid YAML", () => {
		expect(frontmatterView("title: [unclosed")).toEqual({ kind: "raw" });
		expect(frontmatterView("a: 1\na: 2")).toEqual({ kind: "raw" });
	});

	it("falls back to raw when the YAML is not a mapping", () => {
		expect(frontmatterView("just text")).toEqual({ kind: "raw" });
		expect(frontmatterView("- a\n- b")).toEqual({ kind: "raw" });
	});
});

const position = {
	start: { line: 1, column: 1, offset: 0 },
	end: { line: 3, column: 4, offset: 15 },
};

// biome-ignore lint/suspicious/noExplicitAny: hand-built mdast nodes
const run = (children: any[]) => {
	const tree = { type: "root", children };
	remarkFrontmatterTable()(tree);
	return tree;
};

const paragraph = {
	type: "paragraph",
	children: [{ type: "text", value: "Body" }],
};

describe("remarkFrontmatterTable", () => {
	it("replaces the yaml node with a frontmatter table, keeping its position", () => {
		const tree = run([
			{ type: "yaml", value: "title: Hi", position },
			paragraph,
		]);
		const node = tree.children[0];
		expect(node.type).toBe("frontmatter");
		expect(node.position).toBe(position);
		expect(node.data.hName).toBe("table");
		expect(node.data.hProperties).toEqual({ className: ["frontmatter"] });
		const row = node.data.hChildren[0].children[0];
		expect(row.children.map((c: { tagName: string }) => c.tagName)).toEqual([
			"th",
			"td",
		]);
		expect(tree.children[1]).toBe(paragraph);
	});

	it("wraps a block value in <code>", () => {
		const tree = run([{ type: "yaml", value: "seo:\n  a: 1", position }]);
		const td = tree.children[0].data.hChildren[0].children[0].children[1];
		expect(td.children[0]).toMatchObject({ tagName: "code" });
	});

	it("removes an empty block", () => {
		const tree = run([{ type: "yaml", value: "", position }, paragraph]);
		expect(tree.children).toEqual([paragraph]);
	});

	it("turns invalid YAML into a yaml code block", () => {
		const tree = run([{ type: "yaml", value: "a: [", position }]);
		expect(tree.children[0]).toEqual({
			type: "code",
			lang: "yaml",
			value: "a: [",
			position,
		});
	});

	it("leaves a document without frontmatter alone", () => {
		const tree = run([paragraph]);
		expect(tree.children).toEqual([paragraph]);
	});
});

describe("sanitizing the frontmatter table", () => {
	it("keeps the frontmatter class and drops any other", () => {
		// biome-ignore lint/suspicious/noExplicitAny: rehypeSanitize's returned transform isn't typed for direct invocation
		const sanitize = rehypeSanitize(markdownSanitizeSchema) as any;
		const table = (className: string[]) => ({
			type: "root",
			children: [
				{
					type: "element",
					tagName: "table",
					properties: { className },
					children: [],
				},
			],
		});
		expect(sanitize(table(["frontmatter"])).children[0].properties).toEqual({
			className: ["frontmatter"],
		});
		expect(
			sanitize(table(["evil"])).children[0].properties.className ?? [],
		).not.toContain("evil");
	});
});

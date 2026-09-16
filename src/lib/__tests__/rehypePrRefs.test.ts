import { describe, expect, it } from "vitest";
import { linkifyPrRefs } from "../rehypePrRefs";

const REPO = "https://github.com/emullernl/abundio";

// Minimal hast builders — the plugin only ever looks at type/tagName/value/children.
// biome-ignore lint/suspicious/noExplicitAny: hast tree, as in rehypeSourceLines
type Node = any;
const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[]): Node => ({
	type: "element",
	tagName,
	properties: {},
	children,
});
const root = (children: Node[]): Node => ({ type: "root", children });

/** Flattens a tree back to a readable string: links render as [text](href). */
function render(node: Node): string {
	if (node.type === "text") return node.value;
	if (node.tagName === "a") {
		return `[${node.children.map(render).join("")}](${node.properties.href})`;
	}
	return (node.children ?? []).map(render).join("");
}

describe("linkifyPrRefs", () => {
	it("links a bare PR reference", () => {
		const tree = root([el("p", [text("Fixed the thing (#180)")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe(`Fixed the thing ([#180](${REPO}/pull/180))`);
	});

	it("links several references in one line", () => {
		const tree = root([el("p", [text("See #1 and #22.")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe(
			`See [#1](${REPO}/pull/1) and [#22](${REPO}/pull/22).`,
		);
	});

	it("links a reference at the very start of a line", () => {
		const tree = root([el("p", [text("#7 landed")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe(`[#7](${REPO}/pull/7) landed`);
	});

	it("descends into nested markup", () => {
		const tree = root([
			el("ul", [el("li", [el("strong", [text("Dim slot")]), text(" (#180)")])]),
		]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toContain(`[#180](${REPO}/pull/180)`);
	});
});

describe("linkifyPrRefs — what it must leave alone", () => {
	it("leaves code spans alone", () => {
		const tree = root([el("p", [el("code", [text("printf '#180'")])])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("printf '#180'");
	});

	it("leaves code blocks alone", () => {
		const tree = root([el("pre", [el("code", [text("# 1\nid=#42")])])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("# 1\nid=#42");
	});

	it("does not nest a link inside a link", () => {
		const tree = root([el("a", [text("see #180")])]);
		tree.children[0].properties.href = "https://example.test";
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("[see #180](https://example.test)");
	});

	it("leaves @mentions and commit SHAs as plain text", () => {
		const tree = root([el("p", [text("thanks @someone, see f63ad8c")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("thanks @someone, see f63ad8c");
	});

	it("leaves a hash glued to a word alone", () => {
		const tree = root([el("p", [text("abc#12 and item#3")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("abc#12 and item#3");
	});

	it("leaves a doubled hash alone", () => {
		const tree = root([el("p", [text("##180")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("##180");
	});

	it("leaves a hash with no digits alone", () => {
		const tree = root([el("p", [text("# heading-ish and #")])]);
		linkifyPrRefs(tree, REPO);
		expect(render(tree)).toBe("# heading-ish and #");
	});

	it("does not touch text without references", () => {
		const paragraph = el("p", [text("nothing to see here")]);
		const before = paragraph.children;
		linkifyPrRefs(root([paragraph]), REPO);
		// Same array instance: the common case rebuilds nothing.
		expect(paragraph.children).toBe(before);
	});
});

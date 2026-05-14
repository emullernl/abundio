import rehypeSanitize from "rehype-sanitize";
import { describe, expect, it } from "vitest";
import { markdownSanitizeSchema } from "../markdownSanitizeSchema";

// `rehypeSanitize(schema)` returns a transform `(tree) => tree`. Running a
// hand-built hast tree through it exercises the exact plugin + schema the
// preview pane uses — without pulling in the whole remark/rehype pipeline.
// biome-ignore lint/suspicious/noExplicitAny: hand-built hast nodes
const sanitize = (tree: any) =>
	(rehypeSanitize(markdownSanitizeSchema) as any)(tree);

// biome-ignore lint/suspicious/noExplicitAny: hast element helper
const el = (tagName: string, properties: any = {}, children: any[] = []) => ({
	type: "element",
	tagName,
	properties,
	children,
});

// biome-ignore lint/suspicious/noExplicitAny: hast root helper
const root = (children: any[]) => ({ type: "root", children });

// biome-ignore lint/suspicious/noExplicitAny: walk hast tree
function findTag(node: any, tagName: string): any {
	if (node.type === "element" && node.tagName === tagName) return node;
	for (const child of node.children ?? []) {
		const hit = findTag(child, tagName);
		if (hit) return hit;
	}
	return null;
}

describe("markdownSanitizeSchema", () => {
	it("strips dangerous raw-HTML elements", () => {
		for (const tag of [
			"iframe",
			"script",
			"object",
			"embed",
			"style",
			"base",
			"form",
			"link",
		]) {
			const out = sanitize(root([el(tag, { src: "https://evil.example/" })]));
			expect(findTag(out, tag), `${tag} should be removed`).toBeNull();
		}
	});

	it("strips event-handler and javascript: attributes from allowed elements", () => {
		const out = sanitize(
			root([
				el("img", { src: "x", onError: "alert(1)" }),
				el("a", { href: "javascript:alert(1)" }, [
					{ type: "text", value: "x" },
				]),
			]),
		);
		expect(findTag(out, "img").properties.onError).toBeUndefined();
		expect(findTag(out, "a").properties.href).toBeUndefined();
	});

	it("preserves dataSourceLine anchors for scroll sync", () => {
		const out = sanitize(
			root([el("p", { dataSourceLine: 12 }, [{ type: "text", value: "hi" }])]),
		);
		expect(findTag(out, "p").properties.dataSourceLine).toBe(12);
	});

	it("preserves the autolink-headings anchor class", () => {
		const out = sanitize(
			root([el("a", { className: ["anchor"], href: "#h" })]),
		);
		expect(findTag(out, "a").properties.className).toEqual(["anchor"]);
	});

	it("keeps language-* classes so mermaid code blocks still render", () => {
		const out = sanitize(
			root([el("code", { className: ["language-mermaid"] })]),
		);
		expect(findTag(out, "code").properties.className).toEqual([
			"language-mermaid",
		]);
	});
});

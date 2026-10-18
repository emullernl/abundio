import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownRendered } from "../MarkdownRendered";

// The whole pipeline — @uiw's remark/rehype chain plus ours and the sanitizer —
// so a regression in plugin order or the sanitize schema shows up here.

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(content: string): HTMLElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => {
		root?.render(
			<MarkdownRendered
				content={content}
				baseDir="/ws"
				resolvedMode="light"
				zoom={1}
				onLinkClick={() => {}}
			/>,
		);
	});
	return host;
}

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

describe("MarkdownRendered frontmatter", () => {
	it("renders frontmatter as a table, not a heading", () => {
		const el = render("---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n");
		const table = el.querySelector("table.frontmatter");
		expect(table).not.toBeNull();
		expect(table?.getAttribute("data-source-line")).toBe("1");
		const cells = [...(table?.querySelectorAll("th, td") ?? [])].map(
			(c) => c.textContent,
		);
		expect(cells).toEqual(["title", "Hello", "tags", "a, b"]);
		expect(el.querySelector("h2")).toBeNull();
		expect(el.querySelector("hr")).toBeNull();
		expect(el.querySelector("h1")?.textContent).toContain("Body");
	});

	it("renders invalid frontmatter as a code block", () => {
		const el = render("---\ntitle: [oops\n---\n\nBody\n");
		expect(el.querySelector("table.frontmatter")).toBeNull();
		expect(el.querySelector("pre code")?.textContent).toContain("title: [oops");
		expect(el.querySelector("h2")).toBeNull();
	});

	it("renders an empty block as nothing", () => {
		const el = render("---\n---\n\nBody\n");
		expect(el.querySelector("table, pre, hr, h2")).toBeNull();
		expect(el.textContent).toContain("Body");
	});

	it("leaves a later thematic break alone", () => {
		const el = render("Intro\n\n---\n\nMore\n");
		expect(el.querySelector("hr")).not.toBeNull();
		expect(el.querySelector("table.frontmatter")).toBeNull();
	});
});

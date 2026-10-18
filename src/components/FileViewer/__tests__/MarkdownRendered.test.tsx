import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRendered } from "../MarkdownRendered";

const writeClipboardText = vi.fn(async (_text: string) => {});
vi.mock("../../../lib/clipboard", () => ({
	writeClipboardText: (text: string) => writeClipboardText(text),
}));

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
	writeClipboardText.mockClear();
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

describe("MarkdownRendered code block copy button", () => {
	async function clickCopy(pre: Element | null | undefined) {
		const button = pre?.querySelector("button.abundio-code-copy");
		expect(button).not.toBeNull();
		await act(async () => {
			(button as HTMLButtonElement).click();
		});
		return button as HTMLButtonElement;
	}

	it("puts one copy button on each code block, and none of @uiw's", () => {
		const el = render(
			"```sh\necho one\n```\n\n```\ntwo\n```\n\nSome `inline` code\n",
		);
		expect(el.querySelectorAll("pre")).toHaveLength(2);
		expect(el.querySelectorAll("pre button.abundio-code-copy")).toHaveLength(2);
		expect(el.querySelectorAll("button.abundio-code-copy")).toHaveLength(2);
		expect(el.querySelector(".copied")).toBeNull();
	});

	it("copies the code shown, without the trailing newline", async () => {
		const el = render("```ts\nconst a = 1;\nconst b = 2;\n```\n");
		const button = await clickCopy(el.querySelector("pre"));
		expect(writeClipboardText).toHaveBeenCalledWith(
			"const a = 1;\nconst b = 2;",
		);
		expect(button.getAttribute("data-state")).toBe("copied");
		expect(button.getAttribute("aria-label")).toBe("Copied");
	});

	it("keeps a deliberate blank last line", async () => {
		const el = render("```\nx\n\n```\n");
		await clickCopy(el.querySelector("pre"));
		expect(writeClipboardText).toHaveBeenCalledWith("x\n");
	});

	it("copies a Mermaid diagram's source", async () => {
		const el = render("```mermaid\ngraph TD\n  A --> B\n```\n");
		const pre = el.querySelector("pre");
		expect(pre?.querySelector(".abundio-mermaid")).not.toBeNull();
		await clickCopy(pre);
		expect(writeClipboardText).toHaveBeenCalledWith("graph TD\n  A --> B");
	});

	it("copies the visible code, never a raw-HTML data-code", async () => {
		const el = render(
			'<pre><code>echo hi</code><div class="copied" data-code="rm -rf ~"></div></pre>\n',
		);
		await clickCopy(el.querySelector("pre"));
		expect(writeClipboardText).toHaveBeenCalledWith("echo hi");
	});

	it("shows failure when the clipboard write throws", async () => {
		writeClipboardText.mockRejectedValueOnce(new Error("denied"));
		const el = render("```\nx\n```\n");
		const button = await clickCopy(el.querySelector("pre"));
		expect(button.getAttribute("data-state")).toBe("failed");
		expect(button.getAttribute("aria-label")).toBe("Copy failed");
	});
});

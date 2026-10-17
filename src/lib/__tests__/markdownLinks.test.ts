import { describe, expect, it } from "vitest";
import { classifyMarkdownLink, scrollToFragment } from "../markdownLinks";

const BASE = "/repo/docs";
const ROOT = "/repo";

describe("classifyMarkdownLink", () => {
	it("ignores an empty href", () => {
		expect(classifyMarkdownLink(undefined, BASE, ROOT)).toEqual({
			kind: "ignore",
		});
		expect(classifyMarkdownLink("  ", BASE, ROOT)).toEqual({ kind: "ignore" });
	});

	it("reads #heading as a fragment, decoded", () => {
		expect(classifyMarkdownLink("#getting-started", BASE, ROOT)).toEqual({
			kind: "fragment",
			id: "getting-started",
		});
		expect(classifyMarkdownLink("#caf%C3%A9", BASE, ROOT)).toEqual({
			kind: "fragment",
			id: "café",
		});
		expect(classifyMarkdownLink("#", BASE, ROOT)).toEqual({ kind: "ignore" });
	});

	it("hands http(s) and mailto to the OS", () => {
		for (const url of [
			"https://example.com",
			"HTTP://example.com/x",
			"mailto:a@b.c",
		]) {
			expect(classifyMarkdownLink(url, BASE, ROOT)).toEqual({
				kind: "external",
				url,
			});
		}
	});

	it("ignores every other scheme", () => {
		for (const url of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"vscode://x",
		]) {
			expect(classifyMarkdownLink(url, BASE, ROOT)).toEqual({ kind: "ignore" });
		}
	});

	it("resolves a relative markdown link against the file's folder", () => {
		expect(classifyMarkdownLink("../README.md", BASE, ROOT)).toEqual({
			kind: "workspace-markdown",
			path: "/repo/README.md",
		});
		expect(
			classifyMarkdownLink("./guide%20one.md#install", BASE, ROOT),
		).toEqual({ kind: "workspace-markdown", path: "/repo/docs/guide one.md" });
	});

	it("accepts an absolute path inside the Workspace", () => {
		expect(classifyMarkdownLink("/repo/a/b.mdx", BASE, ROOT)).toEqual({
			kind: "workspace-markdown",
			path: "/repo/a/b.mdx",
		});
	});

	it("refuses markdown outside the Workspace", () => {
		expect(classifyMarkdownLink("../../etc/x.md", BASE, ROOT)).toEqual({
			kind: "ignore",
		});
		// A sibling folder sharing the root's prefix is still outside.
		expect(classifyMarkdownLink("/repo-other/x.md", BASE, ROOT)).toEqual({
			kind: "ignore",
		});
	});

	it("ignores links to files that are not markdown", () => {
		expect(classifyMarkdownLink("./image.png", BASE, ROOT)).toEqual({
			kind: "ignore",
		});
	});
});

describe("scrollToFragment", () => {
	it("prefers the sanitizer-prefixed id", () => {
		const el = document.createElement("div");
		el.innerHTML = '<h2 id="intro"></h2><h2 id="user-content-intro"></h2>';
		const [plain, prefixed] = Array.from(el.children) as HTMLElement[];
		plain.scrollIntoView = () => {
			throw new Error("wrong target");
		};
		let scrolled = false;
		prefixed.scrollIntoView = () => {
			scrolled = true;
		};
		expect(scrollToFragment(el, "intro")).toBe(true);
		expect(scrolled).toBe(true);
	});

	it("returns false when nothing matches", () => {
		const el = document.createElement("div");
		expect(scrollToFragment(el, "missing")).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import {
	defaultMarkdownView,
	effectiveMarkdownView,
	markdownLinkTarget,
} from "../markdownView";
import { setFileNodeView } from "../paneTree";
import type { PaneNode } from "../types";

describe("effectiveMarkdownView", () => {
	const base = {
		stored: undefined,
		openRendered: true,
		isMarkdown: true,
		isUnmerged: false,
	};

	it("follows the setting when the pane has no view of its own", () => {
		expect(effectiveMarkdownView(base)).toBe("rendered");
		expect(effectiveMarkdownView({ ...base, openRendered: false })).toBe(
			"source",
		);
	});

	it("keeps a stored view whatever the setting", () => {
		expect(effectiveMarkdownView({ ...base, stored: "source" })).toBe("source");
		expect(
			effectiveMarkdownView({
				...base,
				stored: "rendered",
				openRendered: false,
			}),
		).toBe("rendered");
	});

	it("shows source for a file that is not markdown", () => {
		expect(
			effectiveMarkdownView({ ...base, stored: "rendered", isMarkdown: false }),
		).toBe("source");
	});

	it("shows source while the file has merge conflicts", () => {
		expect(
			effectiveMarkdownView({ ...base, stored: "rendered", isUnmerged: true }),
		).toBe("source");
	});
});

describe("defaultMarkdownView", () => {
	it("maps the setting to a view", () => {
		expect(defaultMarkdownView(true)).toBe("rendered");
		expect(defaultMarkdownView(false)).toBe("source");
	});
});

describe("markdownLinkTarget", () => {
	const none = { metaKey: false, ctrlKey: false };
	it("opens a Tab on a plain click", () => {
		expect(markdownLinkTarget(none, true)).toBe("tab");
		expect(markdownLinkTarget(none, false)).toBe("tab");
		expect(markdownLinkTarget(undefined, true)).toBe("tab");
	});

	it("opens a File window on Cmd+click on macOS, Ctrl+click elsewhere", () => {
		expect(markdownLinkTarget({ ...none, metaKey: true }, true)).toBe("window");
		expect(markdownLinkTarget({ ...none, ctrlKey: true }, true)).toBe("tab");
		expect(markdownLinkTarget({ ...none, ctrlKey: true }, false)).toBe(
			"window",
		);
		expect(markdownLinkTarget({ ...none, metaKey: true }, false)).toBe("tab");
	});
});

describe("setFileNodeView", () => {
	const file: PaneNode = { type: "file", id: "f", filePath: "/w/a.md" };
	const tree: PaneNode = {
		type: "split",
		id: "s",
		direction: "vertical",
		ratio: 0.5,
		first: { type: "terminal", id: "t", ptyId: "" },
		second: file,
	};

	it("sets the view on the matching file node", () => {
		const next = setFileNodeView(tree, "f", "source");
		expect(next).not.toBe(tree);
		expect(next.type === "split" && next.second).toEqual({
			...file,
			markdownView: "source",
		});
	});

	it("returns the same tree when nothing changes", () => {
		expect(setFileNodeView(tree, "missing", "source")).toBe(tree);
		const set = setFileNodeView(tree, "f", "rendered");
		expect(setFileNodeView(set, "f", "rendered")).toBe(set);
	});
});

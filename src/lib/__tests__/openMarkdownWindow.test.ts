import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ markdownWindows: { open: vi.fn() } }));

import type { FilePaneState } from "../../stores/explorerStore";
import {
	clickOpensMarkdownWindow,
	markdownFileForPane,
} from "../openMarkdownWindow";
import type { PaneNode } from "../types";

const pane = (filePath: string) => ({ filePath }) as FilePaneState;

describe("clickOpensMarkdownWindow", () => {
	const none = { metaKey: false, ctrlKey: false };
	const meta = { metaKey: true, ctrlKey: false };
	const ctrl = { metaKey: false, ctrlKey: true };

	it("uses Cmd on macOS and Ctrl elsewhere", () => {
		expect(clickOpensMarkdownWindow(meta, "/r/a.md", true)).toBe(true);
		expect(clickOpensMarkdownWindow(ctrl, "/r/a.md", true)).toBe(false);
		expect(clickOpensMarkdownWindow(ctrl, "/r/a.md", false)).toBe(true);
		expect(clickOpensMarkdownWindow(meta, "/r/a.md", false)).toBe(false);
	});

	it("never fires for a plain click or a file that is not markdown", () => {
		expect(clickOpensMarkdownWindow(none, "/r/a.md", true)).toBe(false);
		expect(clickOpensMarkdownWindow(meta, "/r/a.ts", true)).toBe(false);
	});
});

describe("markdownFileForPane", () => {
	const layout: PaneNode = {
		type: "split",
		id: "s",
		direction: "vertical",
		ratio: 0.5,
		first: { type: "file", id: "f1", filePath: "/r/a.md" } as PaneNode,
		second: { type: "preview", id: "p1", sourcePaneId: "f1" },
	};
	const filePanes = { f1: pane("/r/a.md"), f2: pane("/r/b.ts") };

	it("reads a File pane's own file", () => {
		expect(markdownFileForPane("f1", layout, filePanes)).toBe("/r/a.md");
	});

	it("follows a Preview pane to its source", () => {
		expect(markdownFileForPane("p1", layout, filePanes)).toBe("/r/a.md");
	});

	it("is null for a file that is not markdown or an unknown pane", () => {
		expect(markdownFileForPane("f2", layout, filePanes)).toBeNull();
		expect(markdownFileForPane("t9", layout, filePanes)).toBeNull();
	});
});

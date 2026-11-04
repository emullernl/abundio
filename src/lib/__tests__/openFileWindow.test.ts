import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ fileWindows: { open: vi.fn() } }));

import type { FilePaneState } from "../../stores/explorerStore";
import { fileWindowKindFor } from "../fileWindowKind";
import {
	clickOpensFileWindow,
	fileWindowTargetForPane,
	fileWindowTargetForPath,
} from "../openFileWindow";
import type { PaneNode } from "../types";

const pane = (
	filePath: string,
	extra: Partial<FilePaneState> = {},
): FilePaneState => ({ filePath, fileType: "text", ...extra }) as FilePaneState;

describe("fileWindowKindFor", () => {
	it("gives text to ordinary files, including ones with no extension", () => {
		for (const p of ["/r/a.md", "/r/a.ts", "/r/Makefile", "/r/.gitignore"]) {
			expect(fileWindowKindFor(p), p).toBe("text");
		}
	});

	it("gives image to the formats the image viewer shows", () => {
		for (const p of ["/r/a.png", "C:\\r\\a.JPG", "/r/icon.svg", "/r/a.webp"]) {
			expect(fileWindowKindFor(p), p).toBe("image");
		}
	});

	it("gives nothing to known binary files", () => {
		for (const p of ["/r/a.zip", "/r/a.pdf", "/r/a.woff2", "/r/a.sqlite"]) {
			expect(fileWindowKindFor(p), p).toBeNull();
		}
	});
});

describe("fileWindowTargetForPath", () => {
	it("wraps the kind with the path", () => {
		expect(fileWindowTargetForPath("/r/a.png")).toEqual({
			kind: "image",
			filePath: "/r/a.png",
		});
		expect(fileWindowTargetForPath("/r/a.zip")).toBeNull();
	});
});

describe("clickOpensFileWindow", () => {
	const none = { metaKey: false, ctrlKey: false };
	const meta = { metaKey: true, ctrlKey: false };
	const ctrl = { metaKey: false, ctrlKey: true };

	it("uses Cmd on macOS and Ctrl elsewhere", () => {
		expect(clickOpensFileWindow(meta, "/r/a.md", true)).toBe(true);
		expect(clickOpensFileWindow(ctrl, "/r/a.md", true)).toBe(false);
		expect(clickOpensFileWindow(ctrl, "/r/a.md", false)).toBe(true);
		expect(clickOpensFileWindow(meta, "/r/a.md", false)).toBe(false);
	});

	it("covers every file that has a File window, and only those", () => {
		expect(clickOpensFileWindow(meta, "/r/a.ts", true)).toBe(true);
		expect(clickOpensFileWindow(meta, "/r/a.png", true)).toBe(true);
		expect(clickOpensFileWindow(meta, "/r/a.zip", true)).toBe(false);
		expect(clickOpensFileWindow(none, "/r/a.md", true)).toBe(false);
	});
});

describe("fileWindowTargetForPane", () => {
	const layout: PaneNode = {
		type: "split",
		id: "s",
		direction: "vertical",
		ratio: 0.5,
		first: { type: "file", id: "f1", filePath: "/r/a.md" } as PaneNode,
		second: { type: "preview", id: "p1", sourcePaneId: "f1" },
	};
	const filePanes: Record<string, FilePaneState> = {
		f1: pane("/r/a.md"),
		ts: pane("/r/b.ts"),
		img: pane("/r/logo.png", { fileType: "image" }),
		bin: pane("/r/a.bin", { fileType: "binary" }),
		live: pane("diff:src/b.ts", {
			fileType: "diff",
			diffSource: "git",
			diffSection: "staged",
		}),
		bare: pane("diff:src/c.ts", {
			fileType: "diff",
			diffSource: "git",
			diffSection: null,
		}),
		commit: pane("diff@a1b2c3d4:src/b.ts", {
			fileType: "diff",
			diffSource: "git",
		}),
		patch: pane("/r/fix.patch", { fileType: "diff", diffSource: "file" }),
	};

	const target = (id: string) => fileWindowTargetForPane(id, layout, filePanes);

	it("gives a text or image pane's own file", () => {
		expect(target("ts")).toEqual({ kind: "text", filePath: "/r/b.ts" });
		expect(target("img")).toEqual({ kind: "image", filePath: "/r/logo.png" });
	});

	it("follows a Preview pane to its source", () => {
		expect(target("p1")).toEqual({ kind: "text", filePath: "/r/a.md" });
	});

	it("gives a live diff pane's diff, with its section", () => {
		expect(target("live")).toEqual({
			kind: "diff",
			filePath: "src/b.ts",
			diffSection: "staged",
		});
		// A pane that lost its section still opens, on the unstaged changes.
		expect(target("bare")).toMatchObject({ diffSection: "unstaged" });
	});

	it("gives a Commit diff pane that commit's diff", () => {
		expect(target("commit")).toEqual({
			kind: "commit-diff",
			filePath: "src/b.ts",
			commitOid: "a1b2c3d4",
		});
	});

	it("opens a .patch shown as a diff as the file it is", () => {
		expect(target("patch")).toEqual({ kind: "text", filePath: "/r/fix.patch" });
	});

	it("is null for a binary pane or an unknown pane", () => {
		expect(target("bin")).toBeNull();
		expect(target("t9")).toBeNull();
	});
});

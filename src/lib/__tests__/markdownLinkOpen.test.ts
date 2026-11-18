import { beforeEach, describe, expect, it, vi } from "vitest";

const { openWindow, openFile } = vi.hoisted(() => ({
	openWindow: vi.fn(() => Promise.resolve()),
	openFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
	open: vi.fn(() => Promise.resolve()),
}));
vi.mock("../openFileWindow", () => ({ openFileWindow: openWindow }));
vi.mock("../../stores/explorerStore", () => ({
	useExplorerStore: { getState: () => ({ openFile }) },
}));
vi.mock("../platform", () => ({ isMac: true }));

import { followRenderedLink } from "../markdownLinkOpen";

const base = {
	baseDir: "/w/docs",
	workspaceId: "ws",
	workspaceRoot: "/w",
	scrollEl: null,
};
const plain = { metaKey: false, ctrlKey: false };

beforeEach(() => {
	openWindow.mockClear();
	openFile.mockClear();
});

describe("followRenderedLink", () => {
	it("opens a linked markdown file in a Tab, rendered", () => {
		followRenderedLink({ ...base, href: "guide.md", modifiers: plain });
		expect(openFile).toHaveBeenCalledWith("ws", "/w/docs/guide.md", {
			view: "rendered",
		});
		expect(openWindow).not.toHaveBeenCalled();
	});

	it("opens a File window on Cmd+click", () => {
		followRenderedLink({
			...base,
			href: "guide.md",
			modifiers: { ...plain, metaKey: true },
		});
		expect(openWindow).toHaveBeenCalledWith("ws", {
			kind: "text",
			filePath: "/w/docs/guide.md",
			view: "rendered",
		});
		expect(openFile).not.toHaveBeenCalled();
	});

	it("hands the file to openInTab when given (an Orchestrator tab)", () => {
		const openInTab = vi.fn();
		followRenderedLink({
			...base,
			href: "guide.md",
			modifiers: plain,
			openInTab,
		});
		expect(openInTab).toHaveBeenCalledWith("/w/docs/guide.md");
		expect(openFile).not.toHaveBeenCalled();
	});

	it("ignores a link outside the Workspace", () => {
		followRenderedLink({ ...base, href: "../../etc/x.md", modifiers: plain });
		expect(openFile).not.toHaveBeenCalled();
		expect(openWindow).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFile, writeFile, fileDiff } = vi.hoisted(() => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	fileDiff: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
	fs: { readFile, writeFile },
	git: { fileDiff },
	workspaces: { update: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../../components/FileViewer/CodeEditor", () => ({
	clearEditorStateCache: vi.fn(),
	getSerializableEditorState: vi.fn(() => null),
}));

// Pane-1 lives in tab-1's layout as a file leaf
const PANE_LAYOUT = JSON.stringify({
	type: "file",
	id: "pane-1",
	filePath: "/tmp/ws1/src/main.ts",
});
// Diff panes track a repo-relative path (git requires it), unlike text panes
// which use an absolute path. The fs watcher emits absolute paths regardless.
const PANE_LAYOUT_DIFF = JSON.stringify({
	type: "file",
	id: "pane-diff",
	filePath: "diff:src/main.ts",
	isDiff: true,
});

vi.mock("../workspaceStore", () => ({
	useWorkspaceStore: {
		getState: vi.fn(() => ({
			workspaces: [
				{
					id: "ws-1",
					rootFolder: "/tmp/ws1",
					baseBranch: "main",
					tabs: [{ id: "tab-1", layoutJson: PANE_LAYOUT }],
				},
			],
			activeTabByWorkspace: { "ws-1": "tab-1" },
			focusedPaneId: null,
			setFocusedPane: vi.fn(),
			updateLayout: vi.fn(() => Promise.resolve()),
			createTab: vi.fn(() => Promise.resolve()),
		})),
	},
}));

import type { FilePaneState } from "../explorerStore";
import { useExplorerStore } from "../explorerStore";

function makeTextPane(overrides: Partial<FilePaneState> = {}): FilePaneState {
	return {
		filePath: "/tmp/ws1/src/main.ts",
		fileName: "main.ts",
		fileType: "text",
		content: "original content",
		mime: "text/plain",
		isDirty: false,
		language: "typescript",
		diffSource: null,
		externallyChanged: false,
		deletedOnDisk: false,
		loading: false,
		diffOriginal: null,
		diffModified: null,
		diffSection: null,
		isDeleted: false,
		...overrides,
	};
}

function makeDiffPane(overrides: Partial<FilePaneState> = {}): FilePaneState {
	return {
		filePath: "diff:src/main.ts",
		fileName: "main.ts (diff)",
		fileType: "diff",
		content: null,
		mime: null,
		isDirty: false,
		language: "typescript",
		diffSource: "git",
		externallyChanged: false,
		deletedOnDisk: false,
		loading: false,
		diffOriginal: "old",
		diffModified: "new",
		diffSection: "unstaged",
		isDeleted: false,
		...overrides,
	};
}

function setPane(paneId: string, state: FilePaneState) {
	useExplorerStore.setState({
		filePanes: { [paneId]: state },
	});
}

beforeEach(() => {
	readFile.mockReset();
	writeFile.mockReset();
	fileDiff.mockReset();
	useExplorerStore.setState({
		filePanes: {},
		expandedDirs: {},
		dirContents: {},
		pendingGotoLine: null,
	});
});

describe("handleFsChange — text panes", () => {
	it("silently reloads a clean pane when disk content differs", async () => {
		setPane("pane-1", makeTextPane());
		readFile.mockResolvedValue({
			fileType: "text",
			content: "new disk content",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.content).toBe("new disk content");
		expect(pane.isDirty).toBe(false);
		expect(pane.externallyChanged).toBe(false);
	});

	it("flags a dirty pane as externallyChanged without overwriting content", async () => {
		setPane("pane-1", makeTextPane({ isDirty: true, content: "my edits" }));
		readFile.mockResolvedValue({
			fileType: "text",
			content: "other process wrote this",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.content).toBe("my edits");
		expect(pane.isDirty).toBe(true);
		expect(pane.externallyChanged).toBe(true);
	});

	it("is a no-op when disk content matches the pane (self-save guard)", async () => {
		setPane("pane-1", makeTextPane({ content: "same" }));
		readFile.mockResolvedValue({
			fileType: "text",
			content: "same",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.content).toBe("same");
		expect(pane.externallyChanged).toBe(false);
	});

	it("clears externallyChanged flag when disk matches after self-save", async () => {
		setPane(
			"pane-1",
			makeTextPane({
				content: "same",
				externallyChanged: true,
				isDirty: false,
			}),
		);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "same",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(
			useExplorerStore.getState().filePanes["pane-1"].externallyChanged,
		).toBe(false);
	});
});

describe("handleFsChange — deletions", () => {
	it("flags deletedOnDisk on matching text pane", async () => {
		setPane("pane-1", makeTextPane());

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", [], ["/tmp/ws1/src/main.ts"]);

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.deletedOnDisk).toBe(true);
		expect(pane.content).toBe("original content");
	});

	it("deletion wins when same path appears in both changed and removed sets", async () => {
		setPane("pane-1", makeTextPane());
		await useExplorerStore
			.getState()
			.handleFsChange(
				"ws-1",
				["/tmp/ws1/src/main.ts"],
				["/tmp/ws1/src/main.ts"],
			);

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.deletedOnDisk).toBe(true);
		expect(readFile).not.toHaveBeenCalled();
	});
});

describe("handleFsChange — diff panes", () => {
	it("re-runs the git diff when the underlying file changes", async () => {
		// Override workspace mock to have a diff pane layout
		const { useWorkspaceStore } = await import("../workspaceStore");
		vi.mocked(useWorkspaceStore.getState).mockReturnValueOnce({
			workspaces: [
				{
					id: "ws-1",
					rootFolder: "/tmp/ws1",
					baseBranch: "main",
					tabs: [{ id: "tab-1", layoutJson: PANE_LAYOUT_DIFF }],
				},
			],
			activeTabByWorkspace: { "ws-1": "tab-1" },
			focusedPaneId: null,
			setFocusedPane: vi.fn(),
			updateLayout: vi.fn(() => Promise.resolve()),
			createTab: vi.fn(() => Promise.resolve()),
		} as never);

		setPane("pane-diff", makeDiffPane());
		fileDiff.mockResolvedValue({ original: "old2", modified: "new2" });

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(fileDiff).toHaveBeenCalledWith(
			"/tmp/ws1",
			"src/main.ts",
			"unstaged",
			"main",
		);
		const pane = useExplorerStore.getState().filePanes["pane-diff"];
		expect(pane.diffOriginal).toBe("old2");
		expect(pane.diffModified).toBe("new2");
	});

	it("skips diff refresh when section is missing", async () => {
		const { useWorkspaceStore } = await import("../workspaceStore");
		vi.mocked(useWorkspaceStore.getState).mockReturnValueOnce({
			workspaces: [
				{
					id: "ws-1",
					rootFolder: "/tmp/ws1",
					baseBranch: "main",
					tabs: [{ id: "tab-1", layoutJson: PANE_LAYOUT_DIFF }],
				},
			],
			activeTabByWorkspace: { "ws-1": "tab-1" },
			focusedPaneId: null,
			setFocusedPane: vi.fn(),
			updateLayout: vi.fn(() => Promise.resolve()),
			createTab: vi.fn(() => Promise.resolve()),
		} as never);

		setPane("pane-diff", makeDiffPane({ diffSection: null }));

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(fileDiff).not.toHaveBeenCalled();
	});
});

describe("reloadPaneFromDisk", () => {
	it("overwrites content and clears dirty + externallyChanged", async () => {
		setPane(
			"pane-1",
			makeTextPane({
				content: "unsaved edits",
				isDirty: true,
				externallyChanged: true,
			}),
		);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "disk content",
			mime: "text/plain",
		});

		await useExplorerStore.getState().reloadPaneFromDisk("pane-1");

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.content).toBe("disk content");
		expect(pane.isDirty).toBe(false);
		expect(pane.externallyChanged).toBe(false);
	});
});

describe("dismissExternalChange", () => {
	it("clears flags without touching content", () => {
		setPane(
			"pane-1",
			makeTextPane({
				content: "my edits",
				isDirty: true,
				externallyChanged: true,
			}),
		);

		useExplorerStore.getState().dismissExternalChange("pane-1");

		const pane = useExplorerStore.getState().filePanes["pane-1"];
		expect(pane.externallyChanged).toBe(false);
		expect(pane.content).toBe("my edits");
		expect(pane.isDirty).toBe(true);
	});
});

describe("conflicted files open as ordinary text panes", () => {
	it("saves an emptied file instead of silently no-opping", async () => {
		// Resolving a conflict can legitimately empty a file. A truthiness guard
		// on `content` would write nothing and then stage the unchanged file.
		useExplorerStore.setState({
			filePanes: {
				p1: {
					filePath: "/repo/a.txt",
					fileName: "a.txt",
					fileType: "text",
					content: "",
					mime: null,
					isDirty: true,
					language: null,
					diffSource: null,
					externallyChanged: false,
					deletedOnDisk: false,
					loading: false,
					diffOriginal: null,
					diffModified: null,
					diffSection: null,
					isDeleted: false,
				},
			},
		});

		await useExplorerStore.getState().saveFile("p1");

		expect(writeFile).toHaveBeenCalledWith("/repo/a.txt", "");
		expect(useExplorerStore.getState().filePanes.p1?.isDirty).toBe(false);
	});

	it("still refuses to save a pane whose content has not loaded", () => {
		useExplorerStore.setState({
			filePanes: {
				p2: {
					filePath: "/repo/b.txt",
					fileName: "b.txt",
					fileType: "text",
					content: null,
					mime: null,
					isDirty: false,
					language: null,
					diffSource: null,
					externallyChanged: false,
					deletedOnDisk: false,
					loading: true,
					diffOriginal: null,
					diffModified: null,
					diffSection: null,
					isDeleted: false,
				},
			},
		});
		return useExplorerStore
			.getState()
			.saveFile("p2")
			.then(() => {
				expect(writeFile).not.toHaveBeenCalledWith("/repo/b.txt", null);
			});
	});

	describe("standalone patch files", () => {
		it("switches a loaded patch from editable text to diff view", () => {
			setPane(
				"patch-1",
				makeTextPane({
					filePath: "/tmp/ws1/sample.diff",
					fileName: "sample.diff",
					content: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
				}),
			);

			useExplorerStore.getState().viewFileAsDiff("patch-1");

			const pane = useExplorerStore.getState().filePanes["patch-1"];
			expect(pane.fileType).toBe("diff");
			expect(pane.diffSource).toBe("file");
			expect(pane.diffOriginal).toBe("old");
			expect(pane.diffModified).toBe("new");
		});
	});
});

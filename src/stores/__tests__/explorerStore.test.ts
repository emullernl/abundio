import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFile, writeFile, fileDiff, workspacesUpdate } = vi.hoisted(() => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	fileDiff: vi.fn(),
	workspacesUpdate: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/ipc", () => ({
	fs: {
		readFile,
		writeFile,
	},
	git: {
		fileDiff,
	},
	workspaces: {
		update: workspacesUpdate,
	},
}));

vi.mock("../../components/FileViewer/CodeEditor", () => ({
	clearEditorStateCache: vi.fn(),
	getSerializableEditorState: vi.fn(() => null),
}));

vi.mock("../workspaceStore", () => ({
	useWorkspaceStore: {
		getState: vi.fn(() => ({
			setActiveView: vi.fn(),
			activeView: {},
			workspaces: [
				{
					id: "ws-1",
					rootFolder: "/tmp/ws1",
					baseBranch: "main",
				},
			],
		})),
	},
}));

import type { FileTab } from "../explorerStore";
import { useExplorerStore } from "../explorerStore";

function makeTextTab(overrides: Partial<FileTab> = {}): FileTab {
	return {
		id: overrides.id ?? "tab-1",
		workspaceId: "ws-1",
		filePath: "/tmp/ws1/src/main.ts",
		fileName: "main.ts",
		fileType: "text",
		content: "original content",
		mime: "text/plain",
		isDirty: false,
		language: "typescript",
		initialEditorState: null,
		diffOriginal: null,
		diffModified: null,
		diffSection: null,
		externallyChanged: false,
		deletedOnDisk: false,
		...overrides,
	};
}

function makeDiffTab(overrides: Partial<FileTab> = {}): FileTab {
	return {
		id: "diff-1",
		workspaceId: "ws-1",
		filePath: "diff:/tmp/ws1/src/main.ts",
		fileName: "main.ts (diff)",
		fileType: "diff",
		content: null,
		mime: null,
		isDirty: false,
		language: "typescript",
		initialEditorState: null,
		diffOriginal: "old",
		diffModified: "new",
		diffSection: "unstaged",
		externallyChanged: false,
		deletedOnDisk: false,
		...overrides,
	};
}

function setTabs(tabs: FileTab[]) {
	useExplorerStore.setState({
		fileTabs: tabs,
		activeFileTabId: tabs[0]?.id ?? null,
	});
}

beforeEach(() => {
	readFile.mockReset();
	writeFile.mockReset();
	fileDiff.mockReset();
	useExplorerStore.setState({
		fileTabs: [],
		activeFileTabId: null,
		expandedDirs: {},
		dirContents: {},
		pendingGotoLine: null,
	});
});

describe("handleFsChange — text tabs", () => {
	it("silently reloads a clean tab when disk content differs", async () => {
		setTabs([makeTextTab()]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "new disk content",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.content).toBe("new disk content");
		expect(tab.isDirty).toBe(false);
		expect(tab.externallyChanged).toBe(false);
	});

	it("flags a dirty tab as externallyChanged without overwriting content", async () => {
		setTabs([makeTextTab({ isDirty: true, content: "my edits" })]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "other process wrote this",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.content).toBe("my edits");
		expect(tab.isDirty).toBe(true);
		expect(tab.externallyChanged).toBe(true);
	});

	it("is a no-op when disk content matches the tab (self-save guard)", async () => {
		setTabs([makeTextTab({ content: "same" })]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "same",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.content).toBe("same");
		expect(tab.externallyChanged).toBe(false);
	});

	it("clears externallyChanged flag when disk matches after self-save", async () => {
		setTabs([
			makeTextTab({ content: "same", externallyChanged: true, isDirty: false }),
		]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "same",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(useExplorerStore.getState().fileTabs[0].externallyChanged).toBe(
			false,
		);
	});

	it("leaves unrelated tabs untouched", async () => {
		setTabs([
			makeTextTab({ id: "a", filePath: "/tmp/ws1/a.ts" }),
			makeTextTab({ id: "b", filePath: "/tmp/ws1/b.ts", content: "b orig" }),
		]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "a new",
			mime: "text/plain",
		});

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/a.ts"], []);

		const tabs = useExplorerStore.getState().fileTabs;
		expect(tabs.find((t) => t.id === "a")?.content).toBe("a new");
		expect(tabs.find((t) => t.id === "b")?.content).toBe("b orig");
		expect(readFile).toHaveBeenCalledTimes(1);
	});
});

describe("handleFsChange — deletions", () => {
	it("flags deletedOnDisk on matching text tab", async () => {
		setTabs([makeTextTab()]);

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", [], ["/tmp/ws1/src/main.ts"]);

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.deletedOnDisk).toBe(true);
		expect(tab.content).toBe("original content");
	});

	it("flags deletedOnDisk on matching diff tab (by underlying path)", async () => {
		setTabs([makeDiffTab()]);

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", [], ["/tmp/ws1/src/main.ts"]);

		expect(useExplorerStore.getState().fileTabs[0].deletedOnDisk).toBe(true);
	});

	it("deletion wins when same path appears in both changed and removed sets", async () => {
		setTabs([makeTextTab()]);
		// readFile should NOT be called.
		await useExplorerStore
			.getState()
			.handleFsChange(
				"ws-1",
				["/tmp/ws1/src/main.ts"],
				["/tmp/ws1/src/main.ts"],
			);

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.deletedOnDisk).toBe(true);
		expect(readFile).not.toHaveBeenCalled();
	});
});

describe("handleFsChange — diff tabs", () => {
	it("re-runs the git diff when the underlying file changes", async () => {
		setTabs([makeDiffTab()]);
		fileDiff.mockResolvedValue({ original: "old2", modified: "new2" });

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(fileDiff).toHaveBeenCalledWith(
			"/tmp/ws1",
			"/tmp/ws1/src/main.ts",
			"unstaged",
			"main",
		);
		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.diffOriginal).toBe("old2");
		expect(tab.diffModified).toBe("new2");
	});

	it("skips diff refresh when section is missing", async () => {
		setTabs([makeDiffTab({ diffSection: null })]);

		await useExplorerStore
			.getState()
			.handleFsChange("ws-1", ["/tmp/ws1/src/main.ts"], []);

		expect(fileDiff).not.toHaveBeenCalled();
	});
});

describe("reloadTabFromDisk", () => {
	it("overwrites content and clears dirty + externallyChanged", async () => {
		setTabs([
			makeTextTab({
				content: "unsaved edits",
				isDirty: true,
				externallyChanged: true,
			}),
		]);
		readFile.mockResolvedValue({
			fileType: "text",
			content: "disk content",
			mime: "text/plain",
		});

		await useExplorerStore.getState().reloadTabFromDisk("tab-1");

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.content).toBe("disk content");
		expect(tab.isDirty).toBe(false);
		expect(tab.externallyChanged).toBe(false);
	});
});

describe("dismissExternalChange", () => {
	it("clears flags without touching content", () => {
		setTabs([
			makeTextTab({
				content: "my edits",
				isDirty: true,
				externallyChanged: true,
			}),
		]);

		useExplorerStore.getState().dismissExternalChange("tab-1");

		const tab = useExplorerStore.getState().fileTabs[0];
		expect(tab.externallyChanged).toBe(false);
		expect(tab.content).toBe("my edits");
		expect(tab.isDirty).toBe(true);
	});
});

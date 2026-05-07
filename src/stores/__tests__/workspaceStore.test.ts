import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	workspaces: {
		list: vi.fn(() => Promise.resolve([])),
		create: vi.fn(),
		delete: vi.fn(() => Promise.resolve()),
		reorder: vi.fn(() => Promise.resolve()),
	},
	tabs: {
		create: vi.fn(),
		delete: vi.fn(() => Promise.resolve()),
		update: vi.fn(() => Promise.resolve()),
	},
	pty: {
		deleteLog: vi.fn(() => Promise.resolve()),
		cleanupStaleLogs: vi.fn(() => Promise.resolve()),
	},
}));

vi.mock("../explorerStore", () => ({
	persistFileTabs: vi.fn(),
	useExplorerStore: {
		getState: vi.fn(() => ({
			activeFileTabId: null,
			activeFileTabByWorkspace: {},
			fileTabs: [],
		})),
		setState: vi.fn(),
	},
}));

const markWorkspaceOpened = vi.fn();
const unmarkWorkspaceOpened = vi.fn();
let mockOpenedWorkspaceIds = new Set<string>();
vi.mock("../ptyActivityStore", () => ({
	usePtyActivityStore: {
		getState: vi.fn(() => ({
			markWorkspaceOpened,
			unmarkWorkspaceOpened,
			openedWorkspaceIds: mockOpenedWorkspaceIds,
		})),
	},
}));

vi.mock("../../lib/terminalManager", () => ({
	destroyTerminal: vi.fn(),
}));

import type { PaneNode, Tab, WorkspaceWithTabs } from "../../lib/types";
import { useWorkspaceStore } from "../workspaceStore";

function makeTab(overrides: Partial<Tab> = {}): Tab {
	const layout: PaneNode = { type: "terminal", id: "pane-1", ptyId: "" };
	return {
		id: "tab-1",
		workspaceId: "workspace-1",
		name: "Terminal 1",
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeWorkspace(
	overrides: Partial<WorkspaceWithTabs> = {},
): WorkspaceWithTabs {
	return {
		id: "workspace-1",
		name: "Test Workspace",
		rootFolder: "/tmp",
		envJson: "{}",
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		tabs: [makeTab()],
		...overrides,
	};
}

beforeEach(() => {
	markWorkspaceOpened.mockClear();
	unmarkWorkspaceOpened.mockClear();
	mockOpenedWorkspaceIds = new Set();
	useWorkspaceStore.setState({
		workspaces: [],
		activeWorkspaceId: null,
		switchingWorkspaceId: null,
		activeTabByWorkspace: {},
		focusedPaneId: null,
		focusedPaneByTab: {},
		ptyStatuses: {},
		searchPaneId: null,
		workspacesInitialized: false,
	});
});

describe("workspaceStore", () => {
	describe("loadWorkspaces", () => {
		it("sets workspacesInitialized to true after loading", async () => {
			const { workspaces } = await import("../../lib/ipc");
			vi.mocked(workspaces.list).mockResolvedValueOnce([]);

			expect(useWorkspaceStore.getState().workspacesInitialized).toBe(false);
			await useWorkspaceStore.getState().loadWorkspaces();
			expect(useWorkspaceStore.getState().workspacesInitialized).toBe(true);
		});

		it("does not auto-select any workspace on load", async () => {
			const { workspaces } = await import("../../lib/ipc");
			vi.mocked(workspaces.list).mockResolvedValueOnce([makeWorkspace()]);

			await useWorkspaceStore.getState().loadWorkspaces();
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
		});
	});

	describe("setActiveWorkspace", () => {
		it("sets activeWorkspaceId", () => {
			useWorkspaceStore.getState().setActiveWorkspace("s1");
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("s1");
		});

		it("falls back to first terminal when no saved focus exists", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeTabByWorkspace: { "workspace-1": "tab-1" },
			});

			useWorkspaceStore.getState().setActiveWorkspace("workspace-1");
			expect(useWorkspaceStore.getState().focusedPaneId).toBe("pane-1");
		});

		it("saves and restores focused pane per tab", () => {
			const workspace = makeWorkspace();
			const tab2 = makeTab({ id: "tab-2" });
			const workspace2 = makeWorkspace({ id: "workspace-2", tabs: [tab2] });

			useWorkspaceStore.setState({
				workspaces: [workspace, workspace2],
				activeWorkspaceId: "workspace-1",
				activeTabByWorkspace: {
					"workspace-1": "tab-1",
					"workspace-2": "tab-2",
				},
				focusedPaneId: "pane-focused",
			});

			// Switch to workspace-2 — should save pane-focused for tab-1
			useWorkspaceStore.getState().setActiveWorkspace("workspace-2");
			expect(useWorkspaceStore.getState().focusedPaneByTab["tab-1"]).toBe(
				"pane-focused",
			);
		});
	});

	describe("beginWorkspaceSwitch", () => {
		it("slow path: shows overlay and switches after double rAF for fresh workspaces", () => {
			vi.useFakeTimers();

			// s2 is NOT in openedWorkspaceIds → slow path
			useWorkspaceStore.setState({ activeWorkspaceId: "s1" });
			useWorkspaceStore.getState().beginWorkspaceSwitch("s2");

			expect(useWorkspaceStore.getState().switchingWorkspaceId).toBe("s2");
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("s1");

			// First rAF: nothing changes yet
			vi.advanceTimersToNextTimer();
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("s1");
			expect(useWorkspaceStore.getState().switchingWorkspaceId).toBe("s2");

			// Second rAF: switches and clears overlay in one step
			vi.advanceTimersToNextTimer();
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("s2");
			expect(useWorkspaceStore.getState().switchingWorkspaceId).toBeNull();

			vi.useRealTimers();
		});

		it("fast path: switches instantly with no overlay for already-opened workspaces", () => {
			mockOpenedWorkspaceIds = new Set(["s2"]);

			useWorkspaceStore.setState({ activeWorkspaceId: "s1" });
			useWorkspaceStore.getState().beginWorkspaceSwitch("s2");

			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("s2");
			expect(useWorkspaceStore.getState().switchingWorkspaceId).toBeNull();
		});

		it("is a no-op when target equals current active workspace", () => {
			vi.useFakeTimers();
			const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");

			useWorkspaceStore.setState({ activeWorkspaceId: "s1" });
			useWorkspaceStore.getState().beginWorkspaceSwitch("s1");

			expect(useWorkspaceStore.getState().switchingWorkspaceId).toBeNull();
			expect(rafSpy).not.toHaveBeenCalled();

			rafSpy.mockRestore();
			vi.useRealTimers();
		});
	});

	describe("setActiveTab", () => {
		it("sets active tab for workspace", () => {
			const tab1 = makeTab({ id: "tab-1" });
			const tab2 = makeTab({ id: "tab-2" });
			const workspace = makeWorkspace({ tabs: [tab1, tab2] });

			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
				activeTabByWorkspace: { "workspace-1": "tab-1" },
			});

			useWorkspaceStore.getState().setActiveTab("workspace-1", "tab-2");
			expect(
				useWorkspaceStore.getState().activeTabByWorkspace["workspace-1"],
			).toBe("tab-2");
		});
	});

	describe("reorderWorkspaces", () => {
		it("reorders workspaces by ids", () => {
			const s1 = makeWorkspace({ id: "s1", name: "First" });
			const s2 = makeWorkspace({ id: "s2", name: "Second" });
			useWorkspaceStore.setState({ workspaces: [s1, s2] });

			useWorkspaceStore.getState().reorderWorkspaces(["s2", "s1"]);
			const ids = useWorkspaceStore.getState().workspaces.map((s) => s.id);
			expect(ids).toEqual(["s2", "s1"]);
		});
	});

	describe("createTab", () => {
		it("focuses the first terminal pane in the new tab", async () => {
			const { tabs } = await import("../../lib/ipc");
			const layout: PaneNode = {
				type: "terminal",
				id: "new-pane-1",
				ptyId: "",
			};
			const newTab = makeTab({
				id: "tab-new",
				layoutJson: JSON.stringify(layout),
			});
			vi.mocked(tabs.create).mockResolvedValueOnce(newTab);

			const workspace = makeWorkspace();
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
				activeTabByWorkspace: { "workspace-1": "tab-1" },
			});

			await useWorkspaceStore.getState().createTab("workspace-1");
			expect(useWorkspaceStore.getState().focusedPaneId).toBe("new-pane-1");
		});
	});

	describe("setFocusedPane", () => {
		it("sets focusedPaneId", () => {
			useWorkspaceStore.getState().setFocusedPane("pane-1");
			expect(useWorkspaceStore.getState().focusedPaneId).toBe("pane-1");
		});

		it("does not update state when paneId is already focused", () => {
			useWorkspaceStore.setState({ focusedPaneId: "pane-1" });
			const before = useWorkspaceStore.getState();
			useWorkspaceStore.getState().setFocusedPane("pane-1");
			// Zustand `set` creates a new object, so referential equality verifies no update was made
			expect(useWorkspaceStore.getState()).toBe(before);
		});
	});

	describe("updateLayoutLocal", () => {
		it("updates layout in state without IPC", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });

			const newLayout: PaneNode = {
				type: "terminal",
				id: "new-pane",
				ptyId: "new-pty",
			};
			useWorkspaceStore.getState().updateLayoutLocal("tab-1", newLayout);

			const tab = useWorkspaceStore.getState().workspaces[0].tabs[0];
			expect(JSON.parse(tab.layoutJson)).toEqual(newLayout);
		});
	});

	describe("setPtyStatus", () => {
		it("updates ptyStatuses record", () => {
			useWorkspaceStore.getState().setPtyStatus("pty-1", { type: "running" });
			expect(useWorkspaceStore.getState().ptyStatuses["pty-1"]).toEqual({
				type: "running",
			});
		});
	});

	describe("toggleSearch", () => {
		it("opens search for focused pane", () => {
			useWorkspaceStore.setState({ focusedPaneId: "p1", searchPaneId: null });
			useWorkspaceStore.getState().toggleSearch();
			expect(useWorkspaceStore.getState().searchPaneId).toBe("p1");
		});

		it("closes search when already open for focused pane", () => {
			useWorkspaceStore.setState({ focusedPaneId: "p1", searchPaneId: "p1" });
			useWorkspaceStore.getState().toggleSearch();
			expect(useWorkspaceStore.getState().searchPaneId).toBeNull();
		});
	});

	describe("setWorkspaceBaseBranch", () => {
		it("updates baseBranch in-memory for the target workspace", () => {
			const s1 = makeWorkspace({ id: "s1", baseBranch: null });
			const s2 = makeWorkspace({ id: "s2", baseBranch: null });
			useWorkspaceStore.setState({ workspaces: [s1, s2] });

			useWorkspaceStore.getState().setWorkspaceBaseBranch("s1", "develop");

			expect(
				useWorkspaceStore.getState().workspaces.find((s) => s.id === "s1")
					?.baseBranch,
			).toBe("develop");
			expect(
				useWorkspaceStore.getState().workspaces.find((s) => s.id === "s2")
					?.baseBranch,
			).toBeNull();
		});

		it("clears baseBranch when set to null", () => {
			const workspace = makeWorkspace({ id: "s1", baseBranch: "feature/foo" });
			useWorkspaceStore.setState({ workspaces: [workspace] });

			useWorkspaceStore.getState().setWorkspaceBaseBranch("s1", null);

			expect(
				useWorkspaceStore.getState().workspaces.find((s) => s.id === "s1")
					?.baseBranch,
			).toBeNull();
		});
	});

	describe("derived getters", () => {
		it("getActiveWorkspace returns the active workspace", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
			});
			expect(useWorkspaceStore.getState().getActiveWorkspace()?.id).toBe(
				"workspace-1",
			);
		});

		it("getActiveWorkspace returns undefined when no active workspace", () => {
			expect(useWorkspaceStore.getState().getActiveWorkspace()).toBeUndefined();
		});

		it("getActiveTab returns active tab for active workspace", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
				activeTabByWorkspace: { "workspace-1": "tab-1" },
			});
			expect(useWorkspaceStore.getState().getActiveTab()?.id).toBe("tab-1");
		});

		it("getActiveLayout parses layoutJson", () => {
			const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
			const workspace = makeWorkspace({
				tabs: [makeTab({ layoutJson: JSON.stringify(layout) })],
			});
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
				activeTabByWorkspace: { "workspace-1": "tab-1" },
			});
			expect(useWorkspaceStore.getState().getActiveLayout()).toEqual(layout);
		});

		it("getTabsForWorkspace returns tabs", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });
			expect(
				useWorkspaceStore.getState().getTabsForWorkspace("workspace-1"),
			).toHaveLength(1);
		});

		it("getTabsForWorkspace returns empty for unknown workspace", () => {
			expect(
				useWorkspaceStore.getState().getTabsForWorkspace("unknown"),
			).toEqual([]);
		});
	});

	describe("deleteWorkspace", () => {
		it("unmarks the workspace as opened so its fs watcher stops", async () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });

			await useWorkspaceStore.getState().deleteWorkspace("workspace-1");

			expect(unmarkWorkspaceOpened).toHaveBeenCalledWith("workspace-1");
			expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
		});
	});
});

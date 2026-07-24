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
			unregisterFilePane: vi.fn(),
			clearWorkspaceFilePanes: vi.fn(),
		})),
		setState: vi.fn(),
	},
}));

const markWorkspaceOpened = vi.fn();
const unmarkWorkspaceOpened = vi.fn();
// Referenced eagerly in the terminalManager mock factory (not deferred inside a
// closure like the others), so it must be hoisted alongside the vi.mock call.
const { teardownTerminal } = vi.hoisted(() => ({ teardownTerminal: vi.fn() }));
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
	teardownTerminal,
}));

import { tabs, workspaces } from "../../lib/ipc";
import { collectAgentPanes } from "../../lib/paneTree";
import { takePendingAgent } from "../../lib/pendingAgentRegistry";
import type {
	CodingAgent,
	PaneNode,
	Tab,
	WorkspaceWithTabs,
	WorktreeEntry,
} from "../../lib/types";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { findMutatedTabLayout, useWorkspaceStore } from "../workspaceStore";

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
		profileId: "p-default",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [makeTab()],
		...overrides,
	};
}

beforeEach(() => {
	markWorkspaceOpened.mockClear();
	unmarkWorkspaceOpened.mockClear();
	teardownTerminal.mockClear();
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

		it("restamps position to the new index", () => {
			const s1 = makeWorkspace({ id: "s1", name: "First", position: 0 });
			const s2 = makeWorkspace({ id: "s2", name: "Second", position: 1 });
			const s3 = makeWorkspace({ id: "s3", name: "Third", position: 2 });
			useWorkspaceStore.setState({ workspaces: [s1, s2, s3] });

			useWorkspaceStore.getState().reorderWorkspaces(["s3", "s1", "s2"]);

			// The sidebar sorts rows by `position`, so it must follow the new order.
			expect(
				useWorkspaceStore
					.getState()
					.workspaces.map((s) => [s.id, s.position] as const),
			).toEqual([
				["s3", 0],
				["s1", 1],
				["s2", 2],
			]);
		});

		// Asserts the symptom, not the mechanism: whatever the sidebar derives its
		// row order from, it has to follow the drop.
		it("produces sidebar rows in the dropped order", () => {
			const s1 = makeWorkspace({ id: "s1", name: "First", position: 0 });
			const s2 = makeWorkspace({ id: "s2", name: "Second", position: 1 });
			const s3 = makeWorkspace({ id: "s3", name: "Third", position: 2 });
			useWorkspaceStore.setState({ workspaces: [s1, s2, s3] });

			useWorkspaceStore.getState().reorderWorkspaces(["s3", "s1", "s2"]);

			const rows = buildWorkspaceRows(
				useWorkspaceStore.getState().workspaces,
				{},
			);
			expect(flattenRowsToIds(rows)).toEqual(["s3", "s1", "s2"]);
		});

		// Deletes leave gaps and (historically) duplicate positions behind; the
		// restamp has to normalise them rather than preserve the collision.
		it("normalises sparse and duplicated starting positions", () => {
			const s1 = makeWorkspace({ id: "s1", name: "First", position: 0 });
			const s2 = makeWorkspace({ id: "s2", name: "Second", position: 5 });
			const s3 = makeWorkspace({ id: "s3", name: "Third", position: 5 });
			useWorkspaceStore.setState({ workspaces: [s1, s2, s3] });

			useWorkspaceStore.getState().reorderWorkspaces(["s2", "s3", "s1"]);

			expect(
				useWorkspaceStore
					.getState()
					.workspaces.map((s) => [s.id, s.position] as const),
			).toEqual([
				["s2", 0],
				["s3", 1],
				["s1", 2],
			]);
			const rows = buildWorkspaceRows(
				useWorkspaceStore.getState().workspaces,
				{},
			);
			expect(flattenRowsToIds(rows)).toEqual(["s2", "s3", "s1"]);
		});

		it("keeps workspaces missing from ids instead of dropping them", () => {
			const s1 = makeWorkspace({ id: "s1", name: "First", position: 0 });
			const s2 = makeWorkspace({ id: "s2", name: "Second", position: 1 });
			const s3 = makeWorkspace({ id: "s3", name: "Third", position: 2 });
			useWorkspaceStore.setState({ workspaces: [s1, s2, s3] });

			useWorkspaceStore.getState().reorderWorkspaces(["s3", "s1"]);

			expect(
				useWorkspaceStore
					.getState()
					.workspaces.map((s) => [s.id, s.position] as const),
			).toEqual([
				["s3", 0],
				["s1", 1],
				["s2", 2],
			]);
			// The leftover is persisted too, so the DB can't keep a stale position.
			expect(workspaces.reorder).toHaveBeenCalledWith(["s3", "s1", "s2"]);
		});

		it("rolls back the local order when the persist fails", async () => {
			const s1 = makeWorkspace({ id: "s1", name: "First", position: 0 });
			const s2 = makeWorkspace({ id: "s2", name: "Second", position: 1 });
			useWorkspaceStore.setState({ workspaces: [s1, s2] });
			vi.mocked(workspaces.reorder).mockRejectedValueOnce(new Error("db"));

			useWorkspaceStore.getState().reorderWorkspaces(["s2", "s1"]);
			await vi.waitFor(() =>
				expect(
					useWorkspaceStore.getState().workspaces.map((s) => s.id),
				).toEqual(["s1", "s2"]),
			);
			expect(
				useWorkspaceStore.getState().workspaces.map((s) => s.position),
			).toEqual([0, 1]);
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

	describe("stampAgentOnPane", () => {
		it("persists an agentId onto the matching terminal pane", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });

			useWorkspaceStore.getState().stampAgentOnPane("pane-1", "claude");

			const tab = useWorkspaceStore.getState().workspaces[0].tabs[0];
			expect(collectAgentPanes(JSON.parse(tab.layoutJson))).toEqual([
				{ paneId: "pane-1", agentId: "claude" },
			]);
			expect(tabs.update).toHaveBeenCalledWith("tab-1", {
				layoutJson: tab.layoutJson,
			});
		});

		it("clears a persisted agentId when undefined is passed (manual exit)", () => {
			const layout: PaneNode = {
				type: "terminal",
				id: "pane-1",
				ptyId: "",
				agentId: "claude",
			};
			const workspace = makeWorkspace({
				tabs: [makeTab({ layoutJson: JSON.stringify(layout) })],
			});
			useWorkspaceStore.setState({ workspaces: [workspace] });

			useWorkspaceStore.getState().stampAgentOnPane("pane-1", undefined);

			const tab = useWorkspaceStore.getState().workspaces[0].tabs[0];
			// No agent remains, so a restart's seedPendingAgentsForLayout is a no-op.
			expect(collectAgentPanes(JSON.parse(tab.layoutJson))).toEqual([]);
		});

		it("does nothing when no layout contains the pane", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });
			vi.mocked(tabs.update).mockClear();

			useWorkspaceStore.getState().stampAgentOnPane("missing-pane", "claude");

			expect(tabs.update).not.toHaveBeenCalled();
		});
	});

	describe("stampCwdOnPane", () => {
		it("persists a cwd onto the matching terminal pane", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });

			useWorkspaceStore.getState().stampCwdOnPane("pane-1", "/tmp/project");

			const tab = useWorkspaceStore.getState().workspaces[0].tabs[0];
			expect(JSON.parse(tab.layoutJson)).toMatchObject({
				id: "pane-1",
				cwd: "/tmp/project",
			});
			expect(tabs.update).toHaveBeenCalledWith("tab-1", {
				layoutJson: tab.layoutJson,
			});
		});

		it("clears a persisted cwd when an empty string is passed", () => {
			const layout: PaneNode = {
				type: "terminal",
				id: "pane-1",
				ptyId: "",
				cwd: "/tmp/project",
			};
			const workspace = makeWorkspace({
				tabs: [makeTab({ layoutJson: JSON.stringify(layout) })],
			});
			useWorkspaceStore.setState({ workspaces: [workspace] });

			useWorkspaceStore.getState().stampCwdOnPane("pane-1", "");

			const tab = useWorkspaceStore.getState().workspaces[0].tabs[0];
			expect(JSON.parse(tab.layoutJson)).not.toHaveProperty("cwd");
		});

		it("does nothing when no layout contains the pane", () => {
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });
			vi.mocked(tabs.update).mockClear();

			useWorkspaceStore.getState().stampCwdOnPane("missing-pane", "/tmp");

			expect(tabs.update).not.toHaveBeenCalled();
		});
	});

	describe("findMutatedTabLayout", () => {
		it("returns the tab whose layout the mutator actually changes", () => {
			const workspaceA = makeWorkspace({
				id: "workspace-a",
				tabs: [
					makeTab({
						id: "tab-a",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "pane-a",
							ptyId: "",
						} satisfies PaneNode),
					}),
				],
			});
			const workspaceB = makeWorkspace({
				id: "workspace-b",
				tabs: [
					makeTab({
						id: "tab-b",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "pane-b",
							ptyId: "",
						} satisfies PaneNode),
					}),
				],
			});

			const result = findMutatedTabLayout([workspaceA, workspaceB], (layout) =>
				layout.type === "terminal" && layout.id === "pane-b"
					? { ...layout, agentId: "claude" }
					: layout,
			);

			expect(result).not.toBeNull();
			expect(result?.tabId).toBe("tab-b");
			expect(JSON.parse(result?.layoutJson ?? "")).toMatchObject({
				id: "pane-b",
				agentId: "claude",
			});
		});

		it("returns null when the mutator never returns a changed reference", () => {
			const workspace = makeWorkspace();

			const result = findMutatedTabLayout([workspace], (layout) => layout);

			expect(result).toBeNull();
		});

		it("skips tabs with malformed layoutJson", () => {
			const workspace = makeWorkspace({
				tabs: [makeTab({ layoutJson: "{not json" })],
			});

			const result = findMutatedTabLayout([workspace], (layout) => ({
				...layout,
			}));

			expect(result).toBeNull();
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

		it("tears down every pane so Overview counts drop on a direct delete", async () => {
			// Direct delete (sidebar bulk-delete) skips closeWorkspace, so
			// deleteWorkspace must tear down its own panes. See ADR-0020.
			const workspace = makeWorkspace();
			useWorkspaceStore.setState({ workspaces: [workspace] });

			await useWorkspaceStore.getState().deleteWorkspace("workspace-1");

			expect(teardownTerminal).toHaveBeenCalledWith("pane-1");
		});
	});

	describe("closeTab", () => {
		it("tears down the closed tab's panes but not other tabs'", async () => {
			const tabA = makeTab({
				id: "tab-1",
				layoutJson: JSON.stringify({
					type: "terminal",
					id: "pane-a",
					ptyId: "",
				}),
			});
			const tabB = makeTab({
				id: "tab-2",
				layoutJson: JSON.stringify({
					type: "terminal",
					id: "pane-b",
					ptyId: "",
				}),
			});
			const workspace = makeWorkspace({ tabs: [tabA, tabB] });
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeTabByWorkspace: { "workspace-1": "tab-2" },
			});

			await useWorkspaceStore.getState().closeTab("tab-2");

			expect(teardownTerminal).toHaveBeenCalledWith("pane-b");
			expect(teardownTerminal).not.toHaveBeenCalledWith("pane-a");
			expect(
				useWorkspaceStore.getState().workspaces[0].tabs.map((t) => t.id),
			).toEqual(["tab-1"]);
		});
	});

	describe("closeWorkspace", () => {
		it("tears down every pane and unmarks the workspace as opened", async () => {
			const splitTab = makeTab({
				id: "tab-1",
				layoutJson: JSON.stringify({
					type: "split",
					id: "split-1",
					direction: "horizontal",
					ratio: 0.5,
					first: { type: "terminal", id: "pane-a", ptyId: "" },
					second: { type: "terminal", id: "pane-b", ptyId: "" },
				}),
			});
			const workspace = makeWorkspace({ tabs: [splitTab] });
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "workspace-1",
			});

			await useWorkspaceStore.getState().closeWorkspace("workspace-1");

			expect(teardownTerminal).toHaveBeenCalledWith("pane-a");
			expect(teardownTerminal).toHaveBeenCalledWith("pane-b");
			expect(unmarkWorkspaceOpened).toHaveBeenCalledWith("workspace-1");
			// Closed, not deleted — the workspace stays in the list.
			expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
		});
	});

	describe("addDiscoveredWorktree", () => {
		it("records the active tab so switching later renders the first tab", async () => {
			const { workspaces } = await import("../../lib/ipc");
			const discovered = makeWorkspace({
				id: "wt-1",
				rootFolder: "/repo/feature",
				tabs: [makeTab({ id: "wt-tab-1", workspaceId: "wt-1" })],
			});
			vi.mocked(workspaces.create).mockResolvedValueOnce(discovered);

			await useWorkspaceStore
				.getState()
				.addDiscoveredWorktree("feature", "/repo/feature");

			// The invariant that loadWorkspaces establishes for every workspace:
			// activeTabByWorkspace[id] points at the first tab. Without it,
			// setActiveWorkspace can't resolve a tab and no content renders.
			expect(useWorkspaceStore.getState().activeTabByWorkspace["wt-1"]).toBe(
				"wt-tab-1",
			);
			// Still unopened: not activated, not marked opened.
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
			expect(markWorkspaceOpened).not.toHaveBeenCalled();
		});

		it("activates the first tab when the discovered worktree is switched to", async () => {
			const { workspaces } = await import("../../lib/ipc");
			const discovered = makeWorkspace({
				id: "wt-1",
				rootFolder: "/repo/feature",
				tabs: [makeTab({ id: "wt-tab-1", workspaceId: "wt-1" })],
			});
			vi.mocked(workspaces.create).mockResolvedValueOnce(discovered);

			await useWorkspaceStore
				.getState()
				.addDiscoveredWorktree("feature", "/repo/feature");
			useWorkspaceStore.getState().setActiveWorkspace("wt-1");

			expect(useWorkspaceStore.getState().focusedPaneId).toBe("pane-1");
		});

		it("dedups against an existing workspace for the same folder", async () => {
			const existing = makeWorkspace({ rootFolder: "/repo/feature" });
			useWorkspaceStore.setState({ workspaces: [existing] });

			const result = await useWorkspaceStore
				.getState()
				.addDiscoveredWorktree("feature", "/repo/feature");

			expect(result).toBeNull();
			expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
		});
	});

	describe("addWorktreeWorkspace", () => {
		const agent: CodingAgent = {
			id: "claude",
			name: "Claude Code",
			command: "claude",
			args: [],
			builtin: true,
			enabled: true,
		};
		const entry: WorktreeEntry = {
			path: "/repo/feature",
			branch: "feature",
			isPrimary: false,
			exists: true,
		};

		it("seeds setup commands onto a worktree the watcher raced in first", async () => {
			// Watcher won the race and registered the worktree as an unopened
			// Workspace (no setup commands seeded). Its focal pane has no PTY yet.
			const raced = makeWorkspace({
				id: "wt-1",
				rootFolder: "/repo/feature",
				tabs: [makeTab({ id: "wt-tab-1", workspaceId: "wt-1" })],
			});
			useWorkspaceStore.setState({ workspaces: [raced] });

			const result = await useWorkspaceStore
				.getState()
				.addWorktreeWorkspace(entry, "npm install\nnpm run dev", undefined);

			// Reuses the raced-in entry — no duplicate workspace.
			expect(result).toBe(raced);
			expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
			// Its focal pane carries the configured setup commands so they run once
			// its PTY spawns — the bug was this being silently skipped.
			expect(takePendingAgent("pane-1")).toEqual({
				command: "npm install\nnpm run dev",
			});
		});

		it("seeds the chosen agent when the watcher already raced the entry in", async () => {
			// addDiscoveredWorktree created a bare unopened entry during the slow
			// `git worktree add` — the regression: the agent must not be dropped.
			const discovered = makeWorkspace({
				id: "wt-1",
				rootFolder: "/repo/feature",
				tabs: [
					makeTab({
						id: "wt-tab-1",
						workspaceId: "wt-1",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "wt-pane-1",
							ptyId: "",
						}),
					}),
				],
			});
			useWorkspaceStore.setState({ workspaces: [discovered] });

			const result = await useWorkspaceStore
				.getState()
				.addWorktreeWorkspace(entry, "", agent);

			expect(result).toBe(discovered);
			// No duplicate workspace created for the same folder.
			expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
			expect(takePendingAgent("wt-pane-1")).toEqual({ command: "claude" });
		});

		it("does not re-seed an entry that is already open", async () => {
			mockOpenedWorkspaceIds = new Set(["wt-1"]);
			const discovered = makeWorkspace({
				id: "wt-1",
				rootFolder: "/repo/feature",
				tabs: [
					makeTab({
						id: "wt-tab-1",
						workspaceId: "wt-1",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "open-pane-1",
							ptyId: "pty-live",
						}),
					}),
				],
			});
			useWorkspaceStore.setState({ workspaces: [discovered] });

			await useWorkspaceStore.getState().addWorktreeWorkspace(entry, "", agent);

			expect(takePendingAgent("open-pane-1")).toBeUndefined();
		});

		it("seeds the agent when it creates the entry itself (no race)", async () => {
			const { workspaces } = await import("../../lib/ipc");
			const created = makeWorkspace({
				id: "wt-2",
				rootFolder: "/repo/feature",
				tabs: [
					makeTab({
						id: "wt-tab-2",
						workspaceId: "wt-2",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "new-pane-1",
							ptyId: "",
						}),
					}),
				],
			});
			vi.mocked(workspaces.create).mockResolvedValueOnce(created);

			const result = await useWorkspaceStore
				.getState()
				.addWorktreeWorkspace(entry, "", agent);

			expect(result).toBe(created);
			expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("wt-2");
			expect(takePendingAgent("new-pane-1")).toEqual({ command: "claude" });
		});
	});
});

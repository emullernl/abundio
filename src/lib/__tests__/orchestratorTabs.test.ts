import { beforeEach, describe, expect, it, vi } from "vitest";

const addTab = vi.fn();
const removeTab = vi.fn(() => Promise.resolve());
const selectTab = vi.fn(() => Promise.resolve());
vi.mock("../ipc", async (orig) => ({
	...(await orig<typeof import("../ipc")>()),
	orchestrator: {
		addTab: (...a: unknown[]) => addTab(...a),
		removeTab: (...a: unknown[]) => removeTab(...(a as [])),
		selectTab: (...a: unknown[]) => selectTab(...(a as [])),
	},
}));

const {
	closeOrchestratorTab,
	openOrchestratorFile,
	requestCloseOrchestratorTab,
	tabLabel,
	tabPaneId,
	tabWorkspaceIds,
	toggleOrchestratorFileSearch,
} = await import("../orchestratorTabs");
const { useOrchestratorStore } = await import("../../stores/orchestratorStore");
const { useWorkspaceStore } = await import("../../stores/workspaceStore");
const { useExplorerStore } = await import("../../stores/explorerStore");

const tab = (id: string, path = `/w/${id}.md`, workspaceId = "w") => ({
	id,
	workspaceId,
	kind: "file" as const,
	path,
	commitOid: null,
	preview: false,
});

describe("orchestratorTabs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useOrchestratorStore.setState({
			fileTabs: [],
			selectedTabId: null,
			fileSearch: null,
		});
	});

	it("opens a file once, selecting it when asked", async () => {
		addTab.mockResolvedValue(tab("a"));
		await openOrchestratorFile(
			{ workspaceId: "w", kind: "file", path: "/w/a.md" },
			{ focus: true },
		);
		await openOrchestratorFile(
			{ workspaceId: "w", kind: "file", path: "/w/a.md" },
			{ focus: false },
		);
		const s = useOrchestratorStore.getState();
		expect(s.fileTabs.map((t) => t.id)).toEqual(["a"]);
		expect(s.selectedTabId).toBe("a");
	});

	it("selects the tab to the left, or the graph, when the selected one closes", () => {
		useOrchestratorStore.setState({
			fileTabs: [tab("a"), tab("b"), tab("c")],
			selectedTabId: "b",
		});
		closeOrchestratorTab("b");
		expect(useOrchestratorStore.getState().selectedTabId).toBe("a");
		closeOrchestratorTab("a");
		expect(useOrchestratorStore.getState().selectedTabId).toBeNull();
		expect(removeTab).toHaveBeenCalledTimes(2);
	});

	it("asks before closing a tab with unsaved edits, closes a clean one at once", () => {
		useOrchestratorStore.setState({
			fileTabs: [tab("a"), tab("b")],
			selectedTabId: "a",
			closingTabId: null,
		});
		useExplorerStore.setState({
			filePanes: {
				"orch-tab:a": { isDirty: true },
				"orch-tab:b": { isDirty: false },
			} as never,
		});
		requestCloseOrchestratorTab("a");
		expect(useOrchestratorStore.getState().closingTabId).toBe("a");
		expect(useOrchestratorStore.getState().fileTabs).toHaveLength(2);
		requestCloseOrchestratorTab("b");
		expect(useOrchestratorStore.getState().fileTabs.map((t) => t.id)).toEqual([
			"a",
		]);
	});

	it("searches every work Workspace not missing, or the ones asked", () => {
		useWorkspaceStore.setState({
			workspaces: [
				{ id: "w", kind: "work", tabs: [] },
				{ id: "gone", kind: "work", tabs: [] },
				{ id: "o", kind: "orchestrator", tabs: [] },
			] as never,
			missingFolderIds: new Set(["gone"]),
		});
		toggleOrchestratorFileSearch();
		expect(useOrchestratorStore.getState().fileSearch).toEqual({
			workspaceIds: ["w"],
		});
		toggleOrchestratorFileSearch();
		expect(useOrchestratorStore.getState().fileSearch).toBeNull();
		toggleOrchestratorFileSearch(["gone"]);
		expect(useOrchestratorStore.getState().fileSearch).toEqual({
			workspaceIds: ["gone"],
		});
	});

	it("names tabs, their panes and their Workspaces", () => {
		expect(tabLabel(tab("a", "/w/docs/readme.md"))).toBe("readme.md");
		expect(tabPaneId("x")).toBe("orch-tab:x");
		expect(
			tabWorkspaceIds([tab("a"), tab("b"), tab("c", "/v/c", "v")]),
		).toEqual(["w", "v"]);
	});
});

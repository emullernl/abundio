import { create } from "zustand";
import { pty, workspaces as workspacesApi, tabs as tabsApi } from "../lib/ipc";
import type {
	PaneNode,
	PtyStatusType,
	WorkspaceWithTabs,
	Tab,
} from "../lib/types";
import { persistFileTabs } from "./explorerStore";
import { usePtyActivityStore } from "./ptyActivityStore";

interface WorkspaceState {
	workspaces: WorkspaceWithTabs[];
	activeWorkspaceId: string | null;
	activeTabByWorkspace: Record<string, string>; // workspaceId → active tabId
	focusedPaneId: string | null;
	focusedPaneByTab: Record<string, string>; // tabId → last focused paneId
	maximizedPaneId: string | null;
	savedLayout: PaneNode | null;
	ptyStatuses: Record<string, PtyStatusType>; // ptyId → status
	searchPaneId: string | null; // pane currently showing search bar
	activeView: Record<string, "terminal" | "file">; // workspaceId → current view
	workspacesInitialized: boolean; // true after initial loadWorkspaces() completes

	// Workspace actions
	loadWorkspaces: () => Promise<void>;
	createWorkspace: (name: string, rootFolder: string) => Promise<WorkspaceWithTabs>;
	deleteWorkspace: (id: string) => Promise<void>;
	setActiveWorkspace: (id: string | null) => void;

	reorderWorkspaces: (ids: string[]) => void;

	// Tab actions
	createTab: (workspaceId: string) => Promise<Tab>;
	closeTab: (tabId: string) => Promise<void>;
	setActiveTab: (workspaceId: string, tabId: string) => void;
	renameTab: (tabId: string, name: string) => Promise<void>;

	// Pane/layout actions
	setFocusedPane: (paneId: string | null) => void;
	updateLayout: (tabId: string, layout: PaneNode) => Promise<void>;
	updateLayoutLocal: (tabId: string, layout: PaneNode) => void;
	persistLayout: (tabId: string) => Promise<void>;
	setMaximized: (paneId: string | null, savedLayout: PaneNode | null) => void;
	setPtyStatus: (ptyId: string, status: PtyStatusType) => void;
	toggleSearch: () => void;
	setActiveView: (workspaceId: string, view: "terminal" | "file") => void;
	setWorkspaceBaseBranch: (workspaceId: string, baseBranch: string | null) => void;

	// Derived
	getActiveWorkspace: () => WorkspaceWithTabs | undefined;
	getActiveTab: () => Tab | undefined;
	getActiveLayout: () => PaneNode | null;
	getTabsForWorkspace: (workspaceId: string) => Tab[];
}

function defaultLayout(): PaneNode {
	return { type: "terminal", id: crypto.randomUUID(), ptyId: "" };
}

function firstTerminalId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.id;
	return firstTerminalId(node.first) ?? firstTerminalId(node.second);
}

/** Collect all terminal pane IDs from a layout tree. */
function collectPaneIds(node: PaneNode): string[] {
	if (node.type === "terminal") return [node.id];
	return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

/** Clear all ptyIds in a layout tree so fresh PTYs get spawned on render. */
function clearPtyIds(node: PaneNode): PaneNode {
	if (node.type === "terminal") {
		return { ...node, ptyId: "" };
	}
	return {
		...node,
		first: clearPtyIds(node.first),
		second: clearPtyIds(node.second),
	};
}

/** Update a tab's layoutJson in the workspaces array (immutable). */
function updateTabInWorkspaces(
	workspaces: WorkspaceWithTabs[],
	tabId: string,
	layoutJson: string,
): WorkspaceWithTabs[] {
	return workspaces.map((s) => ({
		...s,
		tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layoutJson } : t)),
	}));
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	workspaces: [],
	activeWorkspaceId: null,
	activeTabByWorkspace: {},
	focusedPaneId: null,
	focusedPaneByTab: {},
	maximizedPaneId: null,
	savedLayout: null,
	ptyStatuses: {},
	searchPaneId: null,
	activeView: {},
	workspacesInitialized: false,

	loadWorkspaces: async () => {
		const workspacesWithTabs = await workspacesApi.list();
		// Clear stale ptyIds from all tabs' layouts
		const allPaneIds: string[] = [];
		const cleaned = workspacesWithTabs.map((s) => ({
			...s,
			tabs: s.tabs.map((t) => {
				try {
					const layout = JSON.parse(t.layoutJson) as PaneNode;
					allPaneIds.push(...collectPaneIds(layout));
					return { ...t, layoutJson: JSON.stringify(clearPtyIds(layout)) };
				} catch {
					return t;
				}
			}),
		}));

		// Set default active tab for each workspace
		const activeTabByWorkspace: Record<string, string> = {};
		for (const s of cleaned) {
			if (s.tabs.length > 0) {
				activeTabByWorkspace[s.id] = s.tabs[0].id;
			}
		}

		set({
			workspaces: cleaned,
			activeTabByWorkspace,
			workspacesInitialized: true,
		});
		pty.cleanupStaleLogs(allPaneIds).catch(() => {});
	},

	createWorkspace: async (name, rootFolder) => {
		const workspaceWithTabs = await workspacesApi.create(name, rootFolder);
		usePtyActivityStore.getState().markWorkspaceOpened(workspaceWithTabs.id);
		const firstTabId = workspaceWithTabs.tabs[0]?.id;
		set((state) => ({
			workspaces: [...state.workspaces, workspaceWithTabs],
			activeWorkspaceId: workspaceWithTabs.id,
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspaceWithTabs.id]: firstTabId,
			},
		}));
		return workspaceWithTabs;
	},

	deleteWorkspace: async (id) => {
		const workspace = get().workspaces.find((s) => s.id === id);
		if (workspace) {
			// Clean up log files for all panes across all tabs
			for (const tab of workspace.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					const paneIds = collectPaneIds(layout);
					for (const paneId of paneIds) {
						pty.deleteLog(paneId).catch(() => {});
					}
				} catch {
					// Layout parse failure — skip cleanup
				}
			}
		}
		await workspacesApi.delete(id);
		set((state) => ({
			workspaces: state.workspaces.filter((s) => s.id !== id),
			activeWorkspaceId:
				state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
		}));
	},

	setActiveWorkspace: (id) => {
		if (id) usePtyActivityStore.getState().markWorkspaceOpened(id);
		return set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the current tab
			const currentWorkspaceId = state.activeWorkspaceId;
			if (currentWorkspaceId && state.focusedPaneId) {
				const currentTabId = state.activeTabByWorkspace[currentWorkspaceId];
				if (currentTabId) {
					focusedPaneByTab[currentTabId] = state.focusedPaneId;
				}
			}
			// Restore focused pane for the new workspace's active tab
			const newTabId = id ? state.activeTabByWorkspace[id] : undefined;
			let restoredFocus: string | null = newTabId
				? (focusedPaneByTab[newTabId] ?? null)
				: null;
			if (!restoredFocus && newTabId) {
				const workspace = state.workspaces.find((s) => s.id === id);
				const tab = workspace?.tabs.find((t) => t.id === newTabId);
				if (tab) {
					try {
						const layout = JSON.parse(tab.layoutJson) as PaneNode;
						restoredFocus = firstTerminalId(layout);
					} catch {
						/* ignore */
					}
				}
			}
			return {
				activeWorkspaceId: id,
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
				maximizedPaneId: null,
				savedLayout: null,
			};
		});
	},

	reorderWorkspaces: (ids) => {
		const { workspaces } = get();
		const byId = new Map(workspaces.map((s) => [s.id, s]));
		const reordered = ids
			.map((id) => byId.get(id))
			.filter(Boolean) as WorkspaceWithTabs[];
		set({ workspaces: reordered });
		workspacesApi.reorder(ids).catch(() => {});
	},

	// ── Tab actions ──

	createTab: async (workspaceId) => {
		const workspace = get().workspaces.find((s) => s.id === workspaceId);
		const nextNum = (workspace?.tabs.length ?? 0) + 1;
		const name = `Terminal ${nextNum}`;
		const tab = await tabsApi.create(workspaceId, name);
		let initialFocus: string | null = null;
		try {
			const layout = JSON.parse(tab.layoutJson) as PaneNode;
			initialFocus = firstTerminalId(layout);
		} catch {
			/* ignore */
		}
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspaceId ? { ...s, tabs: [...s.tabs, tab] } : s,
			),
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspaceId]: tab.id,
			},
			focusedPaneId: initialFocus,
			maximizedPaneId: null,
			savedLayout: null,
		}));
		return tab;
	},

	closeTab: async (tabId) => {
		const state = get();
		// Find which workspace owns this tab
		const workspace = state.workspaces.find((s) =>
			s.tabs.some((t) => t.id === tabId),
		);
		if (!workspace) return;

		const tabIndex = workspace.tabs.findIndex((t) => t.id === tabId);
		const tab = workspace.tabs[tabIndex];

		// Clean up panes in this tab
		if (tab) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				const paneIds = collectPaneIds(layout);
				for (const paneId of paneIds) {
					pty.deleteLog(paneId).catch(() => {});
				}
			} catch {
				// ignore
			}
		}

		// If this is the last tab, create a new one instead of closing
		if (workspace.tabs.length <= 1) {
			const newTab = await tabsApi.create(workspace.id, "Terminal 1");
			await tabsApi.delete(tabId);
			set((state) => ({
				workspaces: state.workspaces.map((s) =>
					s.id === workspace.id ? { ...s, tabs: [newTab] } : s,
				),
				activeTabByWorkspace: {
					...state.activeTabByWorkspace,
					[workspace.id]: newTab.id,
				},
				focusedPaneId: null,
				maximizedPaneId: null,
				savedLayout: null,
			}));
			return;
		}

		await tabsApi.delete(tabId);

		// Pick the next active tab
		const remainingTabs = workspace.tabs.filter((t) => t.id !== tabId);
		const currentActiveTabId = state.activeTabByWorkspace[workspace.id];
		let newActiveTabId = currentActiveTabId;
		if (currentActiveTabId === tabId) {
			// Activate the tab to the left, or the first tab
			const newIndex = Math.min(tabIndex, remainingTabs.length - 1);
			newActiveTabId = remainingTabs[Math.max(0, newIndex)]?.id;
		}

		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspace.id
					? { ...s, tabs: s.tabs.filter((t) => t.id !== tabId) }
					: s,
			),
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspace.id]: newActiveTabId,
			},
			maximizedPaneId: null,
			savedLayout: null,
		}));
	},

	setActiveTab: (workspaceId, tabId) =>
		set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the old tab
			const oldTabId = state.activeTabByWorkspace[workspaceId];
			if (oldTabId && state.focusedPaneId) {
				focusedPaneByTab[oldTabId] = state.focusedPaneId;
			}
			// Restore focused pane for the new tab, falling back to first pane in layout
			let restoredFocus: string | null = focusedPaneByTab[tabId] ?? null;
			if (!restoredFocus) {
				const workspace = state.workspaces.find((s) => s.id === workspaceId);
				const tab = workspace?.tabs.find((t) => t.id === tabId);
				if (tab) {
					try {
						const layout = JSON.parse(tab.layoutJson) as PaneNode;
						restoredFocus = firstTerminalId(layout);
					} catch {
						/* ignore */
					}
				}
			}
			return {
				activeTabByWorkspace: {
					...state.activeTabByWorkspace,
					[workspaceId]: tabId,
				},
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
				maximizedPaneId: null,
				savedLayout: null,
			};
		}),

	renameTab: async (tabId, name) => {
		await tabsApi.update(tabId, { name });
		set((state) => ({
			workspaces: state.workspaces.map((s) => ({
				...s,
				tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
			})),
		}));
	},

	// ── Pane/layout actions ──

	setFocusedPane: (paneId) => {
		if (get().focusedPaneId === paneId) return;
		set({ focusedPaneId: paneId });
	},

	// Full update: local state + persist to SQLite
	updateLayout: async (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		await tabsApi.update(tabId, { layoutJson });
		set((state) => ({
			workspaces: updateTabInWorkspaces(state.workspaces, tabId, layoutJson),
		}));
	},

	// Local-only update (no IPC) — used during drag resize for smooth visuals
	updateLayoutLocal: (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		set((state) => ({
			workspaces: updateTabInWorkspaces(state.workspaces, tabId, layoutJson),
		}));
	},

	// Persist current layout to SQLite — used on mouseup after drag
	persistLayout: async (tabId) => {
		const state = get();
		let tab: Tab | undefined;
		for (const s of state.workspaces) {
			tab = s.tabs.find((t) => t.id === tabId);
			if (tab) break;
		}
		if (!tab) return;
		await tabsApi.update(tabId, { layoutJson: tab.layoutJson });
	},

	setMaximized: (paneId, savedLayout) =>
		set({ maximizedPaneId: paneId, savedLayout }),

	setPtyStatus: (ptyId, status) =>
		set((state) => ({
			ptyStatuses: { ...state.ptyStatuses, [ptyId]: status },
		})),

	toggleSearch: () =>
		set((state) => ({
			searchPaneId:
				state.searchPaneId === state.focusedPaneId ? null : state.focusedPaneId,
		})),

	setActiveView: (workspaceId, view) => {
		set((state) => ({
			activeView: { ...state.activeView, [workspaceId]: view },
		}));
		persistFileTabs(workspaceId);
	},

	setWorkspaceBaseBranch: (workspaceId, baseBranch) =>
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspaceId ? { ...s, baseBranch } : s,
			),
		})),

	// ── Derived ──

	getActiveWorkspace: () => {
		const { workspaces, activeWorkspaceId } = get();
		return workspaces.find((s) => s.id === activeWorkspaceId);
	},

	getActiveTab: () => {
		const state = get();
		const workspace = state.workspaces.find((s) => s.id === state.activeWorkspaceId);
		if (!workspace) return undefined;
		const tabId = state.activeTabByWorkspace[workspace.id];
		return workspace.tabs.find((t) => t.id === tabId);
	},

	getActiveLayout: () => {
		const tab = get().getActiveTab();
		if (!tab) return null;
		try {
			return JSON.parse(tab.layoutJson) as PaneNode;
		} catch {
			return defaultLayout();
		}
	},

	getTabsForWorkspace: (workspaceId) => {
		const workspace = get().workspaces.find((s) => s.id === workspaceId);
		return workspace?.tabs ?? [];
	},
}));

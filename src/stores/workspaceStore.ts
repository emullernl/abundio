import { create } from "zustand";
import { pty, tabs as tabsApi, workspaces as workspacesApi } from "../lib/ipc";
import {
	collectAgentPanes,
	collectPaneIds,
	collectTerminalIds,
	extractNode,
	findFilePaneInTree,
	insertBesideNode,
	pruneOrphanPreviews,
	setAgentId,
	setCwd,
} from "../lib/paneTree";
import { setPendingAgent } from "../lib/pendingAgentRegistry";
import { destroyTerminal } from "../lib/terminalManager";
import type {
	CodingAgent,
	PaneNode,
	PtyStatusType,
	Tab,
	WorkspaceWithTabs,
} from "../lib/types";
import { useExplorerStore } from "./explorerStore";
import { usePtyActivityStore } from "./ptyActivityStore";
import { useSettingsStore } from "./settingsStore";
import { useWorkspaceGitStore } from "./workspaceGitStore";

interface WorkspaceState {
	workspaces: WorkspaceWithTabs[];
	activeWorkspaceId: string | null;
	switchingWorkspaceId: string | null;
	activeTabByWorkspace: Record<string, string>; // workspaceId → active tabId
	focusedPaneId: string | null;
	focusedPaneByTab: Record<string, string>; // tabId → last focused paneId
	ptyStatuses: Record<string, PtyStatusType>; // ptyId → status
	searchPaneId: string | null; // pane currently showing search bar
	workspacesInitialized: boolean; // true after initial loadWorkspaces() completes

	// Workspace actions
	loadWorkspaces: () => Promise<void>;
	createWorkspace: (
		name: string,
		rootFolder: string,
		agent?: CodingAgent,
	) => Promise<WorkspaceWithTabs>;
	deleteWorkspace: (id: string) => Promise<void>;
	closeWorkspace: (id: string) => Promise<void>;
	renameWorkspace: (id: string, name: string) => Promise<void>;
	setActiveWorkspace: (id: string | null) => void;
	beginWorkspaceSwitch: (id: string | null) => void;

	reorderWorkspaces: (ids: string[]) => void;

	// Tab actions
	createTab: (
		workspaceId: string,
		agent?: CodingAgent,
		seedLayout?: PaneNode,
	) => Promise<Tab>;
	closeTab: (tabId: string) => Promise<void>;
	setActiveTab: (workspaceId: string, tabId: string) => void;
	renameTab: (tabId: string, name: string) => Promise<void>;

	// Pane/layout actions
	setFocusedPane: (paneId: string | null) => void;
	stampAgentOnPane: (paneId: string, agentId: string | undefined) => void;
	stampCwdOnPane: (paneId: string, cwd: string) => void;
	updateLayout: (tabId: string, layout: PaneNode) => Promise<void>;
	updateLayoutLocal: (tabId: string, layout: PaneNode) => void;
	persistLayout: (tabId: string) => Promise<void>;
	setPtyStatus: (ptyId: string, status: PtyStatusType) => void;
	toggleSearch: () => void;
	setWorkspaceBaseBranch: (
		workspaceId: string,
		baseBranch: string | null,
	) => void;

	movePaneToTarget: (
		sourceTabId: string,
		sourcePaneId: string,
		target:
			| {
					kind: "pane-edge";
					tabId: string;
					paneId: string;
					edge: "top" | "right" | "bottom" | "left";
			  }
			| { kind: "new-tab" },
	) => Promise<void>;

	// Derived
	getActiveWorkspace: () => WorkspaceWithTabs | undefined;
	getActiveTab: () => Tab | undefined;
	getActiveLayout: () => PaneNode | null;
	getTabsForWorkspace: (workspaceId: string) => Tab[];
}

function defaultLayout(): PaneNode {
	return { type: "terminal", id: crypto.randomUUID(), ptyId: "" };
}

function firstLeafId(node: PaneNode): string | null {
	if (node.type !== "split") return node.id;
	return firstLeafId(node.first) ?? firstLeafId(node.second);
}

function firstTerminalId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.id;
	if (node.type !== "split") return null;
	return firstTerminalId(node.first) ?? firstTerminalId(node.second);
}

/** Clear all ptyIds in a layout tree so fresh PTYs get spawned on render. */
function clearPtyIds(node: PaneNode): PaneNode {
	if (node.type === "terminal") {
		return { ...node, ptyId: "" };
	}
	if (node.type !== "split") return node;
	return {
		...node,
		first: clearPtyIds(node.first),
		second: clearPtyIds(node.second),
	};
}

/**
 * For each terminal pane in the layout that has an agentId, look the agent up
 * in settingsStore and seed pendingAgentRegistry so the agent re-runs the next
 * time the pane spawns its PTY. Agents that no longer exist are skipped — the
 * pane comes up as a plain shell.
 */
function seedPendingAgentsForLayout(layout: PaneNode): void {
	const entries = collectAgentPanes(layout);
	if (entries.length === 0) return;
	const agents: CodingAgent[] = useSettingsStore.getState().agents;
	for (const { paneId, agentId } of entries) {
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) continue;
		setPendingAgent(paneId, {
			command: [agent.command, ...(agent.args ?? [])].join(" "),
		});
	}
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

interface PersistedFileTab {
	id: string;
	filePath: string;
	fileName: string;
}
interface PersistedFileTabState {
	tabs: PersistedFileTab[];
	activeFileTabId: string | null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	workspaces: [],
	activeWorkspaceId: null,
	switchingWorkspaceId: null,
	activeTabByWorkspace: {},
	focusedPaneId: null,
	focusedPaneByTab: {},
	ptyStatuses: {},
	searchPaneId: null,
	workspacesInitialized: false,

	loadWorkspaces: async () => {
		const workspacesWithTabs = await workspacesApi.list();
		// Clear stale ptyIds from all tabs' layouts and re-seed pending agents
		// for any pane whose layout remembers an agentId from a previous session.
		const allPaneIds: string[] = [];
		const cleaned = workspacesWithTabs.map((s) => ({
			...s,
			tabs: s.tabs.map((t) => {
				try {
					const layout = JSON.parse(t.layoutJson) as PaneNode;
					// Prune preview panes orphaned across sessions (their source pane
					// no longer exists) before clearing stale ptyIds.
					const pruned = pruneOrphanPreviews(layout) ?? layout;
					allPaneIds.push(...collectPaneIds(pruned));
					const cleared = clearPtyIds(pruned);
					seedPendingAgentsForLayout(cleared);
					return { ...t, layoutJson: JSON.stringify(cleared) };
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

		// Pre-populate branch chips from the persisted lastBranch so chips appear
		// immediately. The real branch name is fetched the first time each
		// workspace is activated (see setActiveWorkspace).
		const initialGitInfo: Record<
			string,
			import("./workspaceGitStore").WorkspaceGitInfo
		> = {};
		for (const ws of cleaned) {
			if (ws.lastBranch) {
				initialGitInfo[ws.id] = {
					isGitRepo: true,
					currentBranch: ws.lastBranch,
					changedFileCount: 0,
					additions: 0,
					deletions: 0,
				};
			}
		}
		if (Object.keys(initialGitInfo).length > 0) {
			useWorkspaceGitStore.setState((s) => ({
				byWorkspaceId: { ...s.byWorkspaceId, ...initialGitInfo },
			}));
		}

		// One-time migration: convert old fileTabsJson into file-leaf tabs
		for (const s of workspacesWithTabs) {
			if (!s.fileTabsJson || s.fileTabsJson === "{}") continue;
			try {
				const persisted: PersistedFileTabState = JSON.parse(s.fileTabsJson);
				if (!persisted.tabs?.length) continue;
				// Create a new tab for each previously-open file
				for (const ft of persisted.tabs) {
					const seedLayout: PaneNode = {
						type: "file",
						id: crypto.randomUUID(),
						filePath: ft.filePath,
					};
					await get().createTab(s.id, undefined, seedLayout);
				}
				// Clear fileTabsJson so migration doesn't re-run
				workspacesApi.update(s.id, { fileTabsJson: "" }).catch(() => {});
			} catch {
				// Malformed JSON — skip
			}
		}
	},

	createWorkspace: async (name, rootFolder, agent) => {
		const workspaceWithTabs = await workspacesApi.create(name, rootFolder);
		usePtyActivityStore.getState().markWorkspaceOpened(workspaceWithTabs.id);
		const firstTab = workspaceWithTabs.tabs[0];
		const firstTabId = firstTab?.id;
		let firstPaneId: string | null = null;
		if (firstTab) {
			try {
				const layout = JSON.parse(firstTab.layoutJson) as PaneNode;
				firstPaneId = firstTerminalId(layout);
				if (agent && firstPaneId) {
					setPendingAgent(firstPaneId, {
						command: [agent.command, ...(agent.args ?? [])].join(" "),
					});
					// Persist the agent identity into the layout so it survives restarts.
					const stamped = setAgentId(layout, firstPaneId, agent.id);
					const stampedJson = JSON.stringify(stamped);
					firstTab.layoutJson = stampedJson;
					tabsApi
						.update(firstTab.id, { layoutJson: stampedJson })
						.catch(() => {});
				}
			} catch {
				/* ignore */
			}
		}
		set((state) => ({
			workspaces: [...state.workspaces, workspaceWithTabs],
			activeWorkspaceId: workspaceWithTabs.id,
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspaceWithTabs.id]: firstTabId,
			},
			focusedPaneId: firstPaneId ?? state.focusedPaneId,
		}));
		useWorkspaceGitStore
			.getState()
			.fetch(workspaceWithTabs.id, rootFolder, null)
			.catch(() => {});
		return workspaceWithTabs;
	},

	deleteWorkspace: async (id) => {
		const workspace = get().workspaces.find((s) => s.id === id);
		if (workspace) {
			// Clean up log files for all panes across all tabs
			for (const tab of workspace.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					const paneIds = collectTerminalIds(layout);
					for (const paneId of paneIds) {
						pty.deleteLog(paneId).catch(() => {});
					}
				} catch {
					// Layout parse failure — skip cleanup
				}
			}
		}
		await workspacesApi.delete(id);
		usePtyActivityStore.getState().unmarkWorkspaceOpened(id);
		useWorkspaceGitStore.getState().remove(id);
		set((state) => ({
			workspaces: state.workspaces.filter((s) => s.id !== id),
			activeWorkspaceId:
				state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
		}));
	},

	closeWorkspace: async (id) => {
		const state = get();
		const workspace = state.workspaces.find((s) => s.id === id);
		if (!workspace) return;

		const activityStore = usePtyActivityStore.getState();

		// Destroy terminal instances, kill PTYs, and clean up activity state.
		for (const tab of workspace.tabs) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				const paneIds = collectPaneIds(layout);
				for (const paneId of paneIds) {
					destroyTerminal(paneId);
					const ptyId = activityStore.panePtyMap[paneId];
					if (ptyId) {
						pty.kill(ptyId).catch(() => {});
						activityStore.removePty(ptyId);
					}
					activityStore.removePane(paneId);
				}
				// Clean up file pane state
				useExplorerStore.getState().clearWorkspaceFilePanes(id);
			} catch {
				// Layout parse failure — skip
			}
		}

		// Reset dot to grey
		activityStore.unmarkWorkspaceOpened(id);

		// Clear ptyIds from layouts so fresh PTYs spawn on next open, and re-seed
		// pendingAgentRegistry for any pane that remembers an agent.
		const isActive = state.activeWorkspaceId === id;
		set({
			workspaces: state.workspaces.map((s) =>
				s.id === id
					? {
							...s,
							tabs: s.tabs.map((t) => {
								try {
									const layout = JSON.parse(t.layoutJson) as PaneNode;
									const cleared = clearPtyIds(layout);
									seedPendingAgentsForLayout(cleared);
									return {
										...t,
										layoutJson: JSON.stringify(cleared),
									};
								} catch {
									return t;
								}
							}),
						}
					: s,
			),
			activeWorkspaceId: isActive ? null : state.activeWorkspaceId,
			focusedPaneId: isActive ? null : state.focusedPaneId,
		});
	},

	renameWorkspace: async (id, name) => {
		await workspacesApi.update(id, { name });
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === id ? { ...s, name } : s,
			),
		}));
	},

	setActiveWorkspace: (id) => {
		if (id) usePtyActivityStore.getState().markWorkspaceOpened(id);
		set((state) => {
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
						restoredFocus = firstLeafId(layout);
					} catch {
						/* ignore */
					}
				}
			}
			return {
				activeWorkspaceId: id,
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
			};
		});
		// Fetch real branch name and change stats for the newly active workspace.
		// Deferred so the workspace UI (terminals, layout) renders first.
		if (id) {
			setTimeout(() => {
				const ws = get().workspaces.find((s) => s.id === id);
				if (ws) {
					useWorkspaceGitStore
						.getState()
						.fetch(id, ws.rootFolder, ws.baseBranch)
						.catch(() => {});
				}
			}, 500);
		}
	},

	beginWorkspaceSwitch: (id) => {
		if (id === get().activeWorkspaceId) return;
		// Fast path: already mounted — switch instantly with no overlay.
		if (id && usePtyActivityStore.getState().openedWorkspaceIds.has(id)) {
			get().setActiveWorkspace(id);
			return;
		}
		// Slow path: pre-mount the target workspace's DOM behind the overlay,
		// then flip once React has committed the new subtree (~2 frames).
		if (id) usePtyActivityStore.getState().markWorkspaceOpened(id);
		set({ switchingWorkspaceId: id });
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (get().switchingWorkspaceId !== id) return;
				get().setActiveWorkspace(id);
				set({ switchingWorkspaceId: null });
			});
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

	createTab: async (workspaceId, agent, seedLayout) => {
		const workspace = get().workspaces.find((s) => s.id === workspaceId);
		const nextNum = (workspace?.tabs.length ?? 0) + 1;

		// The seed layout may be a bare file leaf, or — for markdown files opened
		// with an auto-opened preview — a split containing the file pane.
		let name = `Terminal ${nextNum}`;
		const seedFilePane = seedLayout ? findFilePaneInTree(seedLayout) : null;
		if (seedFilePane) {
			name = seedFilePane.filePath.split("/").pop() || "file";
		} else if (agent) {
			name = agent.name;
		}

		const tab = await tabsApi.create(workspaceId, name);

		// If caller provided a seed layout (e.g. a file leaf), override the default terminal layout.
		let finalLayout: PaneNode;
		if (seedLayout) {
			finalLayout = seedLayout;
			const layoutJson = JSON.stringify(finalLayout);
			tab.layoutJson = layoutJson;
			tabsApi.update(tab.id, { layoutJson }).catch(() => {});
		} else {
			try {
				finalLayout = JSON.parse(tab.layoutJson) as PaneNode;
			} catch {
				finalLayout = defaultLayout();
			}
		}

		let initialFocus: string | null = firstLeafId(finalLayout);

		if (agent && !seedLayout) {
			const terminalFocus = firstTerminalId(finalLayout);
			if (terminalFocus) {
				setPendingAgent(terminalFocus, {
					command: [agent.command, ...(agent.args ?? [])].join(" "),
				});
				// Persist the agent identity into the layout so it survives restarts.
				const stamped = setAgentId(finalLayout, terminalFocus, agent.id);
				const stampedJson = JSON.stringify(stamped);
				tab.layoutJson = stampedJson;
				tabsApi.update(tab.id, { layoutJson: stampedJson }).catch(() => {});
				initialFocus = terminalFocus;
			}
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
				const termIds = collectTerminalIds(layout);
				for (const paneId of termIds) {
					pty.deleteLog(paneId).catch(() => {});
				}
				// Clean up file pane states for file leaves
				for (const paneId of collectPaneIds(layout)) {
					useExplorerStore.getState().unregisterFilePane(paneId);
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
			// Restore focused pane for the new tab, falling back to first leaf in layout
			let restoredFocus: string | null = focusedPaneByTab[tabId] ?? null;
			if (!restoredFocus) {
				const workspace = state.workspaces.find((s) => s.id === workspaceId);
				const tab = workspace?.tabs.find((t) => t.id === tabId);
				if (tab) {
					try {
						const layout = JSON.parse(tab.layoutJson) as PaneNode;
						restoredFocus = firstLeafId(layout);
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

	// Persist an agent identity onto a terminal pane in its tab's layout.
	stampAgentOnPane: (paneId, agentId) => {
		const state = get();
		let targetTabId: string | null = null;
		let nextLayoutJson: string | null = null;
		for (const ws of state.workspaces) {
			for (const tab of ws.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					const stamped = setAgentId(layout, paneId, agentId);
					if (stamped !== layout) {
						targetTabId = tab.id;
						nextLayoutJson = JSON.stringify(stamped);
						break;
					}
				} catch {
					/* ignore */
				}
			}
			if (targetTabId) break;
		}
		if (!targetTabId || nextLayoutJson === null) return;
		const layoutJson = nextLayoutJson;
		const tabId = targetTabId;
		set((s) => ({
			workspaces: updateTabInWorkspaces(s.workspaces, tabId, layoutJson),
		}));
		tabsApi.update(tabId, { layoutJson }).catch(() => {});
	},

	stampCwdOnPane: (paneId, cwd) => {
		const state = get();
		let targetTabId: string | null = null;
		let nextLayoutJson: string | null = null;
		for (const ws of state.workspaces) {
			for (const tab of ws.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					const stamped = setCwd(layout, paneId, cwd);
					if (stamped !== layout) {
						targetTabId = tab.id;
						nextLayoutJson = JSON.stringify(stamped);
						break;
					}
				} catch {
					/* ignore */
				}
			}
			if (targetTabId) break;
		}
		if (!targetTabId || nextLayoutJson === null) return;
		const layoutJson = nextLayoutJson;
		const tabId = targetTabId;
		set((s) => ({
			workspaces: updateTabInWorkspaces(s.workspaces, tabId, layoutJson),
		}));
		tabsApi.update(tabId, { layoutJson }).catch(() => {});
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

	setPtyStatus: (ptyId, status) =>
		set((state) => ({
			ptyStatuses: { ...state.ptyStatuses, [ptyId]: status },
		})),

	toggleSearch: () =>
		set((state) => ({
			searchPaneId:
				state.searchPaneId === state.focusedPaneId ? null : state.focusedPaneId,
		})),

	setWorkspaceBaseBranch: (workspaceId, baseBranch) =>
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspaceId ? { ...s, baseBranch } : s,
			),
		})),

	movePaneToTarget: async (sourceTabId, sourcePaneId, target) => {
		const state = get();
		const workspace = state.workspaces.find((ws) =>
			ws.tabs.some((t) => t.id === sourceTabId),
		);
		if (!workspace) return;

		const sourceTab = workspace.tabs.find((t) => t.id === sourceTabId);
		if (!sourceTab) return;

		let sourceLayout: PaneNode;
		try {
			sourceLayout = JSON.parse(sourceTab.layoutJson) as PaneNode;
		} catch {
			return;
		}

		const { remaining: sourceRemaining, removed: movedNode } = extractNode(
			sourceLayout,
			sourcePaneId,
		);
		if (!movedNode) return;

		if (target.kind === "pane-edge") {
			const { tabId: destTabId, paneId: targetPaneId, edge } = target;

			if (destTabId === sourceTabId) {
				// Same-tab move: insert beside in the post-extract remaining tree
				if (!sourceRemaining) return;
				const newLayout = insertBesideNode(
					sourceRemaining,
					targetPaneId,
					movedNode,
					edge,
				);
				await get().updateLayout(sourceTabId, newLayout);
				get().setFocusedPane(sourcePaneId);
			} else {
				// Cross-tab move
				const destTab = workspace.tabs.find((t) => t.id === destTabId);
				if (!destTab) return;
				let destLayout: PaneNode;
				try {
					destLayout = JSON.parse(destTab.layoutJson) as PaneNode;
				} catch {
					return;
				}
				const newDestLayout = insertBesideNode(
					destLayout,
					targetPaneId,
					movedNode,
					edge,
				);
				const destJson = JSON.stringify(newDestLayout);

				if (sourceRemaining) {
					const srcJson = JSON.stringify(sourceRemaining);
					await tabsApi.update(sourceTabId, { layoutJson: srcJson });
					await tabsApi.update(destTabId, { layoutJson: destJson });
					set((s) => ({
						workspaces: s.workspaces.map((ws) =>
							ws.id !== workspace.id
								? ws
								: {
										...ws,
										tabs: ws.tabs.map((t) => {
											if (t.id === sourceTabId)
												return { ...t, layoutJson: srcJson };
											if (t.id === destTabId)
												return { ...t, layoutJson: destJson };
											return t;
										}),
									},
						),
						activeTabByWorkspace: {
							...s.activeTabByWorkspace,
							[workspace.id]: destTabId,
						},
						focusedPaneId: sourcePaneId,
					}));
				} else {
					// Source tab becomes empty — do NOT call closeTab (it would
					// pty.deleteLog the moved pane). Do all DB writes first, then
					// a single atomic set so the pane is never in both layouts.
					await tabsApi.update(destTabId, { layoutJson: destJson });
					await tabsApi.delete(sourceTabId);

					set((s) => ({
						workspaces: s.workspaces.map((ws) =>
							ws.id !== workspace.id
								? ws
								: {
										...ws,
										tabs: ws.tabs
											.filter((t) => t.id !== sourceTabId)
											.map((t) =>
												t.id === destTabId ? { ...t, layoutJson: destJson } : t,
											),
									},
						),
						activeTabByWorkspace: {
							...s.activeTabByWorkspace,
							[workspace.id]: destTabId,
						},
						focusedPaneId: sourcePaneId,
					}));
				}
			}
		} else if (target.kind === "new-tab") {
			// Build the new tab name from the moved node type
			const tabName =
				movedNode.type === "file"
					? (movedNode.filePath.split("/").pop() ?? "file")
					: `Terminal ${(workspace.tabs.length + 1).toString()}`;

			// Do all DB writes BEFORE any state update so React never sees
			// the moved paneId in two layouts at the same time (which would
			// cause TerminalPool duplicate-key unmount + deferred destroy).
			const newTab = await tabsApi.create(workspace.id, tabName);
			const movedJson = JSON.stringify(movedNode);
			newTab.layoutJson = movedJson;
			await tabsApi.update(newTab.id, { layoutJson: movedJson });

			if (sourceRemaining) {
				const srcJson = JSON.stringify(sourceRemaining);
				await tabsApi.update(sourceTabId, { layoutJson: srcJson });

				// Single atomic set: source shrinks + new tab appears
				set((s) => ({
					workspaces: s.workspaces.map((ws) =>
						ws.id !== workspace.id
							? ws
							: {
									...ws,
									tabs: [
										...ws.tabs.map((t) =>
											t.id === sourceTabId ? { ...t, layoutJson: srcJson } : t,
										),
										newTab,
									],
								},
					),
					activeTabByWorkspace: {
						...s.activeTabByWorkspace,
						[workspace.id]: newTab.id,
					},
					focusedPaneId: sourcePaneId,
				}));
			} else {
				// Source tab had only the moved pane — delete it.
				// Do NOT call closeTab (which would pty.deleteLog the moved pane).
				await tabsApi.delete(sourceTabId);

				set((s) => ({
					workspaces: s.workspaces.map((ws) =>
						ws.id !== workspace.id
							? ws
							: {
									...ws,
									tabs: [
										...ws.tabs.filter((t) => t.id !== sourceTabId),
										newTab,
									],
								},
					),
					activeTabByWorkspace: {
						...s.activeTabByWorkspace,
						[workspace.id]: newTab.id,
					},
					focusedPaneId: sourcePaneId,
				}));
			}
		}
	},

	// ── Derived ──

	getActiveWorkspace: () => {
		const { workspaces, activeWorkspaceId } = get();
		return workspaces.find((s) => s.id === activeWorkspaceId);
	},

	getActiveTab: () => {
		const state = get();
		const workspace = state.workspaces.find(
			(s) => s.id === state.activeWorkspaceId,
		);
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

import { create } from "zustand";
import type { PaneNode, PtyStatusType, SessionWithTabs, Tab } from "../lib/types";
import { sessions as sessionsApi, tabs as tabsApi, pty } from "../lib/ipc";
import { persistFileTabs } from "./explorerStore";

interface SessionState {
	sessions: SessionWithTabs[];
	activeSessionId: string | null;
	activeTabBySession: Record<string, string>; // sessionId → active tabId
	focusedPaneId: string | null;
	focusedPaneByTab: Record<string, string>; // tabId → last focused paneId
	maximizedPaneId: string | null;
	savedLayout: PaneNode | null;
	ptyStatuses: Record<string, PtyStatusType>; // ptyId → status
	searchPaneId: string | null; // pane currently showing search bar
	activeView: Record<string, "terminal" | "file">; // sessionId → current view

	// Session actions
	loadSessions: () => Promise<void>;
	createSession: (name: string, rootFolder: string) => Promise<SessionWithTabs>;
	deleteSession: (id: string) => Promise<void>;
	setActiveSession: (id: string | null) => void;

	reorderSessions: (ids: string[]) => void;

	// Tab actions
	createTab: (sessionId: string) => Promise<Tab>;
	closeTab: (tabId: string) => Promise<void>;
	setActiveTab: (sessionId: string, tabId: string) => void;
	renameTab: (tabId: string, name: string) => Promise<void>;

	// Pane/layout actions
	setFocusedPane: (paneId: string | null) => void;
	updateLayout: (tabId: string, layout: PaneNode) => Promise<void>;
	updateLayoutLocal: (tabId: string, layout: PaneNode) => void;
	persistLayout: (tabId: string) => Promise<void>;
	setMaximized: (paneId: string | null, savedLayout: PaneNode | null) => void;
	setPtyStatus: (ptyId: string, status: PtyStatusType) => void;
	toggleSearch: () => void;
	setActiveView: (sessionId: string, view: "terminal" | "file") => void;

	// Derived
	getActiveSession: () => SessionWithTabs | undefined;
	getActiveTab: () => Tab | undefined;
	getActiveLayout: () => PaneNode | null;
	getTabsForSession: (sessionId: string) => Tab[];
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

/** Update a tab's layoutJson in the sessions array (immutable). */
function updateTabInSessions(
	sessions: SessionWithTabs[],
	tabId: string,
	layoutJson: string,
): SessionWithTabs[] {
	return sessions.map((s) => ({
		...s,
		tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layoutJson } : t)),
	}));
}

export const useSessionStore = create<SessionState>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	activeTabBySession: {},
	focusedPaneId: null,
	focusedPaneByTab: {},
	maximizedPaneId: null,
	savedLayout: null,
	ptyStatuses: {},
	searchPaneId: null,
	activeView: {},

	loadSessions: async () => {
		const sessionsWithTabs = await sessionsApi.list();
		// Clear stale ptyIds from all tabs' layouts
		const allPaneIds: string[] = [];
		const cleaned = sessionsWithTabs.map((s) => ({
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

		// Set default active tab for each session
		const activeTabBySession: Record<string, string> = {};
		for (const s of cleaned) {
			if (s.tabs.length > 0) {
				activeTabBySession[s.id] = s.tabs[0].id;
			}
		}

		set({ sessions: cleaned, activeTabBySession });
		pty.cleanupStaleLogs(allPaneIds).catch(() => {});
	},

	createSession: async (name, rootFolder) => {
		const sessionWithTabs = await sessionsApi.create(name, rootFolder);
		const firstTabId = sessionWithTabs.tabs[0]?.id;
		set((state) => ({
			sessions: [...state.sessions, sessionWithTabs],
			activeSessionId: sessionWithTabs.id,
			activeTabBySession: {
				...state.activeTabBySession,
				[sessionWithTabs.id]: firstTabId,
			},
		}));
		return sessionWithTabs;
	},

	deleteSession: async (id) => {
		const session = get().sessions.find((s) => s.id === id);
		if (session) {
			// Clean up log files for all panes across all tabs
			for (const tab of session.tabs) {
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
		await sessionsApi.delete(id);
		set((state) => ({
			sessions: state.sessions.filter((s) => s.id !== id),
			activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
		}));
	},

	setActiveSession: (id) =>
		set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the current tab
			const currentSessionId = state.activeSessionId;
			if (currentSessionId && state.focusedPaneId) {
				const currentTabId = state.activeTabBySession[currentSessionId];
				if (currentTabId) {
					focusedPaneByTab[currentTabId] = state.focusedPaneId;
				}
			}
			// Restore focused pane for the new session's active tab
			const newTabId = id ? state.activeTabBySession[id] : undefined;
			const restoredFocus = newTabId ? focusedPaneByTab[newTabId] ?? null : null;
			return {
				activeSessionId: id,
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
				maximizedPaneId: null,
				savedLayout: null,
			};
		}),

	reorderSessions: (ids) => {
		const { sessions } = get();
		const byId = new Map(sessions.map((s) => [s.id, s]));
		const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as SessionWithTabs[];
		set({ sessions: reordered });
		sessionsApi.reorder(ids).catch(() => {});
	},

	// ── Tab actions ──

	createTab: async (sessionId) => {
		const session = get().sessions.find((s) => s.id === sessionId);
		const nextNum = (session?.tabs.length ?? 0) + 1;
		const name = `Terminal ${nextNum}`;
		const tab = await tabsApi.create(sessionId, name);
		set((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === sessionId ? { ...s, tabs: [...s.tabs, tab] } : s,
			),
			activeTabBySession: {
				...state.activeTabBySession,
				[sessionId]: tab.id,
			},
			focusedPaneId: null,
			maximizedPaneId: null,
			savedLayout: null,
		}));
		return tab;
	},

	closeTab: async (tabId) => {
		const state = get();
		// Find which session owns this tab
		const session = state.sessions.find((s) => s.tabs.some((t) => t.id === tabId));
		if (!session) return;

		const tabIndex = session.tabs.findIndex((t) => t.id === tabId);
		const tab = session.tabs[tabIndex];

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
		if (session.tabs.length <= 1) {
			const newTab = await tabsApi.create(session.id, "Terminal 1");
			await tabsApi.delete(tabId);
			set((state) => ({
				sessions: state.sessions.map((s) =>
					s.id === session.id
						? { ...s, tabs: [newTab] }
						: s,
				),
				activeTabBySession: {
					...state.activeTabBySession,
					[session.id]: newTab.id,
				},
				focusedPaneId: null,
				maximizedPaneId: null,
				savedLayout: null,
			}));
			return;
		}

		await tabsApi.delete(tabId);

		// Pick the next active tab
		const remainingTabs = session.tabs.filter((t) => t.id !== tabId);
		const currentActiveTabId = state.activeTabBySession[session.id];
		let newActiveTabId = currentActiveTabId;
		if (currentActiveTabId === tabId) {
			// Activate the tab to the left, or the first tab
			const newIndex = Math.min(tabIndex, remainingTabs.length - 1);
			newActiveTabId = remainingTabs[Math.max(0, newIndex)]?.id;
		}

		set((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === session.id
					? { ...s, tabs: s.tabs.filter((t) => t.id !== tabId) }
					: s,
			),
			activeTabBySession: {
				...state.activeTabBySession,
				[session.id]: newActiveTabId,
			},
			maximizedPaneId: null,
			savedLayout: null,
		}));
	},

	setActiveTab: (sessionId, tabId) =>
		set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the old tab
			const oldTabId = state.activeTabBySession[sessionId];
			if (oldTabId && state.focusedPaneId) {
				focusedPaneByTab[oldTabId] = state.focusedPaneId;
			}
			// Restore focused pane for the new tab, falling back to first pane in layout
			let restoredFocus: string | null = focusedPaneByTab[tabId] ?? null;
			if (!restoredFocus) {
				const session = state.sessions.find((s) => s.id === sessionId);
				const tab = session?.tabs.find((t) => t.id === tabId);
				if (tab) {
					try {
						const layout = JSON.parse(tab.layoutJson) as PaneNode;
						restoredFocus = firstTerminalId(layout);
					} catch { /* ignore */ }
				}
			}
			return {
				activeTabBySession: {
					...state.activeTabBySession,
					[sessionId]: tabId,
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
			sessions: state.sessions.map((s) => ({
				...s,
				tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
			})),
		}));
	},

	// ── Pane/layout actions ──

	setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

	// Full update: local state + persist to SQLite
	updateLayout: async (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		await tabsApi.update(tabId, { layoutJson });
		set((state) => ({
			sessions: updateTabInSessions(state.sessions, tabId, layoutJson),
		}));
	},

	// Local-only update (no IPC) — used during drag resize for smooth visuals
	updateLayoutLocal: (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		set((state) => ({
			sessions: updateTabInSessions(state.sessions, tabId, layoutJson),
		}));
	},

	// Persist current layout to SQLite — used on mouseup after drag
	persistLayout: async (tabId) => {
		const state = get();
		let tab: Tab | undefined;
		for (const s of state.sessions) {
			tab = s.tabs.find((t) => t.id === tabId);
			if (tab) break;
		}
		if (!tab) return;
		await tabsApi.update(tabId, { layoutJson: tab.layoutJson });
	},

	setMaximized: (paneId, savedLayout) => set({ maximizedPaneId: paneId, savedLayout }),

	setPtyStatus: (ptyId, status) =>
		set((state) => ({
			ptyStatuses: { ...state.ptyStatuses, [ptyId]: status },
		})),

	toggleSearch: () =>
		set((state) => ({
			searchPaneId: state.searchPaneId === state.focusedPaneId ? null : state.focusedPaneId,
		})),

	setActiveView: (sessionId, view) => {
		set((state) => ({
			activeView: { ...state.activeView, [sessionId]: view },
		}));
		persistFileTabs(sessionId);
	},

	// ── Derived ──

	getActiveSession: () => {
		const { sessions, activeSessionId } = get();
		return sessions.find((s) => s.id === activeSessionId);
	},

	getActiveTab: () => {
		const state = get();
		const session = state.sessions.find((s) => s.id === state.activeSessionId);
		if (!session) return undefined;
		const tabId = state.activeTabBySession[session.id];
		return session.tabs.find((t) => t.id === tabId);
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

	getTabsForSession: (sessionId) => {
		const session = get().sessions.find((s) => s.id === sessionId);
		return session?.tabs ?? [];
	},
}));

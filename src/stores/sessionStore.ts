import { create } from "zustand";
import type { PaneNode, PtyStatusType, Session } from "../lib/types";
import { sessions as sessionsApi, pty } from "../lib/ipc";

interface SessionState {
	sessions: Session[];
	activeSessionId: string | null;
	focusedPaneId: string | null;
	focusedPaneBySession: Record<string, string>; // sessionId → last focused paneId
	maximizedPaneId: string | null;
	savedLayout: PaneNode | null; // stashed layout while a pane is maximized
	ptyStatuses: Record<string, PtyStatusType>; // ptyId → status
	searchPaneId: string | null; // pane currently showing search bar

	// Actions
	loadSessions: () => Promise<void>;
	createSession: (name: string, rootFolder: string) => Promise<Session>;
	deleteSession: (id: string) => Promise<void>;
	setActiveSession: (id: string | null) => void;
	setFocusedPane: (paneId: string | null) => void;
	updateLayout: (sessionId: string, layout: PaneNode) => Promise<void>;
	updateLayoutLocal: (sessionId: string, layout: PaneNode) => void;
	persistLayout: (sessionId: string) => Promise<void>;
	setMaximized: (paneId: string | null, savedLayout: PaneNode | null) => void;
	setPtyStatus: (ptyId: string, status: PtyStatusType) => void;
	toggleSearch: () => void;

	// Derived
	getActiveSession: () => Session | undefined;
	getActiveLayout: () => PaneNode | null;
}

function defaultLayout(): PaneNode {
	return { type: "terminal", id: crypto.randomUUID(), ptyId: "" };
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

export const useSessionStore = create<SessionState>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	focusedPaneId: null,
	focusedPaneBySession: {},
	maximizedPaneId: null,
	savedLayout: null,
	ptyStatuses: {},
	searchPaneId: null,

	loadSessions: async () => {
		const sessions = await sessionsApi.list();
		// Clear stale ptyIds from persisted layouts — those processes no longer exist
		const allPaneIds: string[] = [];
		const cleaned = sessions.map((s) => {
			try {
				const layout = JSON.parse(s.layoutJson) as PaneNode;
				allPaneIds.push(...collectPaneIds(layout));
				return { ...s, layoutJson: JSON.stringify(clearPtyIds(layout)) };
			} catch {
				return s;
			}
		});
		set({ sessions: cleaned });
		// Remove orphaned log files that don't belong to any current pane
		pty.cleanupStaleLogs(allPaneIds).catch(() => {});
	},

	createSession: async (name, rootFolder) => {
		const session = await sessionsApi.create(name, rootFolder);
		set((state) => ({
			sessions: [session, ...state.sessions],
			activeSessionId: session.id,
		}));
		return session;
	},

	deleteSession: async (id) => {
		// Clean up log files for panes in this session
		const session = get().sessions.find((s) => s.id === id);
		if (session) {
			try {
				const layout = JSON.parse(session.layoutJson) as PaneNode;
				const paneIds = collectPaneIds(layout);
				for (const paneId of paneIds) {
					pty.deleteLog(paneId).catch(() => {});
				}
			} catch {
				// Layout parse failure — skip cleanup
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
			const focusedPaneBySession = { ...state.focusedPaneBySession };
			// Save current focused pane for the old session
			if (state.activeSessionId && state.focusedPaneId) {
				focusedPaneBySession[state.activeSessionId] = state.focusedPaneId;
			}
			// Restore focused pane for the new session
			const restoredFocus = id ? focusedPaneBySession[id] ?? null : null;
			return {
				activeSessionId: id,
				focusedPaneId: restoredFocus,
				focusedPaneBySession,
				maximizedPaneId: null,
				savedLayout: null,
			};
		}),

	setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

	// Full update: local state + persist to SQLite
	updateLayout: async (sessionId, layout) => {
		const layoutJson = JSON.stringify(layout);
		await sessionsApi.update(sessionId, { layoutJson });
		set((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === sessionId ? { ...s, layoutJson } : s,
			),
		}));
	},

	// Local-only update (no IPC) — used during drag resize for smooth visuals
	updateLayoutLocal: (sessionId, layout) => {
		const layoutJson = JSON.stringify(layout);
		set((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === sessionId ? { ...s, layoutJson } : s,
			),
		}));
	},

	// Persist current layout to SQLite — used on mouseup after drag
	persistLayout: async (sessionId) => {
		const session = get().sessions.find((s) => s.id === sessionId);
		if (!session) return;
		await sessionsApi.update(sessionId, { layoutJson: session.layoutJson });
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

	getActiveSession: () => {
		const { sessions, activeSessionId } = get();
		return sessions.find((s) => s.id === activeSessionId);
	},

	getActiveLayout: () => {
		const session = get().getActiveSession();
		if (!session) return null;
		try {
			return JSON.parse(session.layoutJson) as PaneNode;
		} catch {
			return defaultLayout();
		}
	},
}));

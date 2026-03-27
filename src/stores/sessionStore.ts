import { create } from "zustand";
import type { PaneNode, Session } from "../lib/types";
import { sessions as sessionsApi } from "../lib/ipc";

interface SessionState {
	sessions: Session[];
	activeSessionId: string | null;
	focusedPaneId: string | null;
	maximizedPaneId: string | null;
	savedLayout: PaneNode | null; // stashed layout while a pane is maximized

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

	// Derived
	getActiveSession: () => Session | undefined;
	getActiveLayout: () => PaneNode | null;
}

const DEFAULT_LAYOUT: PaneNode = {
	type: "terminal",
	id: "default",
	ptyId: "",
};

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
	maximizedPaneId: null,
	savedLayout: null,

	loadSessions: async () => {
		const sessions = await sessionsApi.list();
		// Clear stale ptyIds from persisted layouts — those processes no longer exist
		const cleaned = sessions.map((s) => {
			try {
				const layout = JSON.parse(s.layoutJson) as PaneNode;
				return { ...s, layoutJson: JSON.stringify(clearPtyIds(layout)) };
			} catch {
				return s;
			}
		});
		set({ sessions: cleaned });
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
		await sessionsApi.delete(id);
		set((state) => ({
			sessions: state.sessions.filter((s) => s.id !== id),
			activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
		}));
	},

	setActiveSession: (id) =>
		set({ activeSessionId: id, focusedPaneId: null, maximizedPaneId: null, savedLayout: null }),

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
			return DEFAULT_LAYOUT;
		}
	},
}));

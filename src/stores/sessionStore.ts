import { create } from "zustand";
import type { PaneNode, Session } from "../lib/types";
import { sessions as sessionsApi } from "../lib/ipc";

interface SessionState {
	sessions: Session[];
	activeSessionId: string | null;
	focusedPaneId: string | null;

	// Actions
	loadSessions: () => Promise<void>;
	createSession: (name: string, rootFolder: string) => Promise<Session>;
	deleteSession: (id: string) => Promise<void>;
	setActiveSession: (id: string | null) => void;
	setFocusedPane: (paneId: string | null) => void;
	updateLayout: (sessionId: string, layout: PaneNode) => Promise<void>;

	// Derived
	getActiveSession: () => Session | undefined;
	getActiveLayout: () => PaneNode | null;
}

const DEFAULT_LAYOUT: PaneNode = {
	type: "terminal",
	id: "default",
	ptyId: "",
};

export const useSessionStore = create<SessionState>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	focusedPaneId: null,

	loadSessions: async () => {
		const sessions = await sessionsApi.list();
		set({ sessions });
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

	setActiveSession: (id) => set({ activeSessionId: id, focusedPaneId: null }),

	setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

	updateLayout: async (sessionId, layout) => {
		const layoutJson = JSON.stringify(layout);
		await sessionsApi.update(sessionId, { layoutJson });
		set((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === sessionId ? { ...s, layoutJson } : s,
			),
		}));
	},

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

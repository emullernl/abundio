import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/ipc", () => ({
	sessions: {
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
}));

vi.mock("../ptyActivityStore", () => ({
	usePtyActivityStore: {
		getState: vi.fn(() => ({ markSessionOpened: vi.fn() })),
	},
}));

import { useSessionStore } from "../sessionStore";
import type { PaneNode, SessionWithTabs, Tab } from "../../lib/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
	const layout: PaneNode = { type: "terminal", id: "pane-1", ptyId: "" };
	return {
		id: "tab-1",
		sessionId: "session-1",
		name: "Terminal 1",
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeSession(overrides: Partial<SessionWithTabs> = {}): SessionWithTabs {
	return {
		id: "session-1",
		name: "Test Session",
		rootFolder: "/tmp",
		envJson: "{}",
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		tabs: [makeTab()],
		...overrides,
	};
}

beforeEach(() => {
	useSessionStore.setState({
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
	});
});

describe("sessionStore", () => {
	describe("setActiveSession", () => {
		it("sets activeSessionId", () => {
			useSessionStore.getState().setActiveSession("s1");
			expect(useSessionStore.getState().activeSessionId).toBe("s1");
		});

		it("clears maximize state", () => {
			useSessionStore.setState({ maximizedPaneId: "p1", savedLayout: { type: "terminal", id: "p1", ptyId: "" } });
			useSessionStore.getState().setActiveSession("s1");
			expect(useSessionStore.getState().maximizedPaneId).toBeNull();
			expect(useSessionStore.getState().savedLayout).toBeNull();
		});

		it("saves and restores focused pane per tab", () => {
			const session = makeSession();
			const tab2 = makeTab({ id: "tab-2" });
			const session2 = makeSession({ id: "session-2", tabs: [tab2] });

			useSessionStore.setState({
				sessions: [session, session2],
				activeSessionId: "session-1",
				activeTabBySession: { "session-1": "tab-1", "session-2": "tab-2" },
				focusedPaneId: "pane-focused",
			});

			// Switch to session-2 — should save pane-focused for tab-1
			useSessionStore.getState().setActiveSession("session-2");
			expect(useSessionStore.getState().focusedPaneByTab["tab-1"]).toBe("pane-focused");
		});
	});

	describe("setActiveTab", () => {
		it("sets active tab for session", () => {
			const tab1 = makeTab({ id: "tab-1" });
			const tab2 = makeTab({ id: "tab-2" });
			const session = makeSession({ tabs: [tab1, tab2] });

			useSessionStore.setState({
				sessions: [session],
				activeSessionId: "session-1",
				activeTabBySession: { "session-1": "tab-1" },
			});

			useSessionStore.getState().setActiveTab("session-1", "tab-2");
			expect(useSessionStore.getState().activeTabBySession["session-1"]).toBe("tab-2");
		});

		it("clears maximize state", () => {
			const session = makeSession();
			useSessionStore.setState({
				sessions: [session],
				activeTabBySession: { "session-1": "tab-1" },
				maximizedPaneId: "p1",
			});

			useSessionStore.getState().setActiveTab("session-1", "tab-1");
			expect(useSessionStore.getState().maximizedPaneId).toBeNull();
		});
	});

	describe("reorderSessions", () => {
		it("reorders sessions by ids", () => {
			const s1 = makeSession({ id: "s1", name: "First" });
			const s2 = makeSession({ id: "s2", name: "Second" });
			useSessionStore.setState({ sessions: [s1, s2] });

			useSessionStore.getState().reorderSessions(["s2", "s1"]);
			const ids = useSessionStore.getState().sessions.map((s) => s.id);
			expect(ids).toEqual(["s2", "s1"]);
		});
	});

	describe("setFocusedPane", () => {
		it("sets focusedPaneId", () => {
			useSessionStore.getState().setFocusedPane("pane-1");
			expect(useSessionStore.getState().focusedPaneId).toBe("pane-1");
		});
	});

	describe("updateLayoutLocal", () => {
		it("updates layout in state without IPC", () => {
			const session = makeSession();
			useSessionStore.setState({ sessions: [session] });

			const newLayout: PaneNode = { type: "terminal", id: "new-pane", ptyId: "new-pty" };
			useSessionStore.getState().updateLayoutLocal("tab-1", newLayout);

			const tab = useSessionStore.getState().sessions[0].tabs[0];
			expect(JSON.parse(tab.layoutJson)).toEqual(newLayout);
		});
	});

	describe("setMaximized", () => {
		it("sets maximizedPaneId and savedLayout", () => {
			const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
			useSessionStore.getState().setMaximized("p1", layout);
			expect(useSessionStore.getState().maximizedPaneId).toBe("p1");
			expect(useSessionStore.getState().savedLayout).toEqual(layout);
		});

		it("clears with null", () => {
			useSessionStore.getState().setMaximized("p1", { type: "terminal", id: "p1", ptyId: "" });
			useSessionStore.getState().setMaximized(null, null);
			expect(useSessionStore.getState().maximizedPaneId).toBeNull();
			expect(useSessionStore.getState().savedLayout).toBeNull();
		});
	});

	describe("setPtyStatus", () => {
		it("updates ptyStatuses record", () => {
			useSessionStore.getState().setPtyStatus("pty-1", { type: "running" });
			expect(useSessionStore.getState().ptyStatuses["pty-1"]).toEqual({ type: "running" });
		});
	});

	describe("toggleSearch", () => {
		it("opens search for focused pane", () => {
			useSessionStore.setState({ focusedPaneId: "p1", searchPaneId: null });
			useSessionStore.getState().toggleSearch();
			expect(useSessionStore.getState().searchPaneId).toBe("p1");
		});

		it("closes search when already open for focused pane", () => {
			useSessionStore.setState({ focusedPaneId: "p1", searchPaneId: "p1" });
			useSessionStore.getState().toggleSearch();
			expect(useSessionStore.getState().searchPaneId).toBeNull();
		});
	});

	describe("setActiveView", () => {
		it("updates activeView for session", () => {
			useSessionStore.getState().setActiveView("s1", "file");
			expect(useSessionStore.getState().activeView["s1"]).toBe("file");
		});
	});

	describe("derived getters", () => {
		it("getActiveSession returns the active session", () => {
			const session = makeSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: "session-1" });
			expect(useSessionStore.getState().getActiveSession()?.id).toBe("session-1");
		});

		it("getActiveSession returns undefined when no active session", () => {
			expect(useSessionStore.getState().getActiveSession()).toBeUndefined();
		});

		it("getActiveTab returns active tab for active session", () => {
			const session = makeSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: "session-1",
				activeTabBySession: { "session-1": "tab-1" },
			});
			expect(useSessionStore.getState().getActiveTab()?.id).toBe("tab-1");
		});

		it("getActiveLayout parses layoutJson", () => {
			const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
			const session = makeSession({ tabs: [makeTab({ layoutJson: JSON.stringify(layout) })] });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: "session-1",
				activeTabBySession: { "session-1": "tab-1" },
			});
			expect(useSessionStore.getState().getActiveLayout()).toEqual(layout);
		});

		it("getTabsForSession returns tabs", () => {
			const session = makeSession();
			useSessionStore.setState({ sessions: [session] });
			expect(useSessionStore.getState().getTabsForSession("session-1")).toHaveLength(1);
		});

		it("getTabsForSession returns empty for unknown session", () => {
			expect(useSessionStore.getState().getTabsForSession("unknown")).toEqual([]);
		});
	});
});

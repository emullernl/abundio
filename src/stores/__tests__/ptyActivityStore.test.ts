import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../../lib/types";
import {
	collectPtyIds,
	computePtyDotStatus,
	computeTabDotStatus,
	computeWorkspaceDotStatus,
	getLastOutputAt,
	type PtyActivityEntry,
	touchLastOutput,
	usePtyActivityStore,
} from "../ptyActivityStore";
import { useWorkspaceStore } from "../workspaceStore";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
}));

vi.mock("../../lib/notificationRouter", () => ({
	findPaneLocation: vi.fn(() => ({
		workspaceId: "ws-1",
		tabId: "tab-1",
	})),
	isPaneVisible: vi.fn(() => false),
}));

const focusMock = vi.hoisted(() => ({ blurredMs: 10_000 as number | null }));
vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => document.hasFocus(),
	getWindowBlurredMs: () => (document.hasFocus() ? null : focusMock.blurredMs),
	addWindowFocusListener: () => () => {},
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
}));

function resetStore() {
	usePtyActivityStore.setState({
		activities: {},
		titles: {},
		panePtyMap: {},
		openedWorkspaceIds: new Set(),
		agentPtyIds: new Set(),
	});
}

function seedWorkspace(id: string, name: string) {
	const ws: WorkspaceWithTabs = {
		id,
		name,
		rootFolder: `/tmp/${id}`,
		envJson: "{}",
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		tabs: [],
	};
	useWorkspaceStore.setState({ workspaces: [ws] });
}

beforeEach(() => {
	resetStore();
	useWorkspaceStore.setState({ workspaces: [] });
});

describe("store actions", () => {
	it("initPty creates an idle entry", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.state).toBe("idle");
		expect(entry.hasEverReceivedOutput).toBe(true);
		expect(entry.lastOutputAt).toBeNull();
	});

	it("initPty is idempotent", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		initPty("pty-1");
		// Should still be active, not reset to idle
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("recordOutput transitions to active", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.state).toBe("active");
		expect(entry.lastOutputAt).not.toBeNull();
	});

	it("recordOutput when already active updates lastOutputAt in external map", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		vi.setSystemTime(1000);
		recordOutput("pty-1");
		vi.setSystemTime(2000);
		recordOutput("pty-1");
		// Hot-path: lastOutputAt is stored in module-level Map (not Zustand state)
		// to avoid re-renders. Zustand state retains the value from the initial transition.
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.lastOutputAt).toBe(1000);
		// The external map has the updated value
		expect(getLastOutputAt("pty-1")).toBe(2000);
	});

	it("markIdle transitions to idle", () => {
		const { initPty, recordOutput, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("markIdle is no-op when already idle", () => {
		const { initPty, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		markIdle("pty-1"); // should not throw
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("recordError transitions to error", () => {
		const { initPty, recordError } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordError("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"error",
		);
	});

	it("markIdle does not override error state", () => {
		const { initPty, recordError, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordError("pty-1");
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"error",
		);
	});

	it("markIdle does not override active state in agent mode", () => {
		const { initPty, recordOutput, setAgentPty, markIdle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		recordOutput("pty-1");
		// Simulates a workspace switch / focus change while the agent is still
		// streaming — must NOT clear the in-progress active state.
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("markIdle still clears ready state in agent mode", () => {
		const { initPty, setAgentPty, recordExitSuccess, markIdle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		recordExitSuccess("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"ready",
		);
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("clearError transitions error to idle", () => {
		const { initPty, recordError, clearError } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordError("pty-1");
		clearError("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("clearError is no-op when not in error state", () => {
		const { initPty, recordOutput, clearError } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		clearError("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("registerPane / removePane", () => {
		const { registerPane, removePane, setTitle } =
			usePtyActivityStore.getState();
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "bash");
		expect(usePtyActivityStore.getState().panePtyMap["pane-1"]).toBe("pty-1");
		expect(usePtyActivityStore.getState().titles["pane-1"]).toBe("bash");

		removePane("pane-1");
		expect(usePtyActivityStore.getState().panePtyMap["pane-1"]).toBeUndefined();
		expect(usePtyActivityStore.getState().titles["pane-1"]).toBeUndefined();
	});

	it("setTitle skips update for same title", () => {
		const { setTitle } = usePtyActivityStore.getState();
		setTitle("pane-1", "bash");
		const stateBefore = usePtyActivityStore.getState();
		setTitle("pane-1", "bash");
		// No new state object should have been created
		expect(usePtyActivityStore.getState().titles).toBe(stateBefore.titles);
	});

	it("markWorkspaceOpened adds to set", () => {
		usePtyActivityStore.getState().markWorkspaceOpened("s1");
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("s1")).toBe(
			true,
		);
	});

	it("removePty removes activity entry", () => {
		const { initPty, removePty } = usePtyActivityStore.getState();
		initPty("pty-1");
		removePty("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"]).toBeUndefined();
	});
});

describe("collectPtyIds", () => {
	it("collects ptyId from terminal node", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(collectPtyIds(node)).toEqual(["pty-1"]);
	});

	it("returns empty for terminal with no ptyId", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
		expect(collectPtyIds(node)).toEqual([]);
	});

	it("uses panePtyMap fallback", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
		expect(collectPtyIds(node, { p1: "pty-mapped" })).toEqual(["pty-mapped"]);
	});

	it("collects from split nodes", () => {
		const node: PaneNode = {
			type: "split",
			id: "s1",
			direction: "horizontal",
			ratio: 0.5,
			first: { type: "terminal", id: "p1", ptyId: "pty-1" },
			second: { type: "terminal", id: "p2", ptyId: "pty-2" },
		};
		expect(collectPtyIds(node)).toEqual(["pty-1", "pty-2"]);
	});
});

describe("computeWorkspaceDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: "shell",
		hookDriven: false,
	});

	it("returns grey when no ptyIds", () => {
		expect(computeWorkspaceDotStatus("s1", [], {}, new Set())).toBe("grey");
	});

	it("returns red when any error", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("error") },
				new Set(),
			),
		).toBe("red");
	});

	it("returns blue when any active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("active") },
				new Set(),
			),
		).toBe("amber");
	});

	it("returns orange when any ready", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("ready") },
				new Set(),
			),
		).toBe("purple");
	});

	it("returns green when all idle and workspace opened", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("idle") },
				new Set(["s1"]),
			),
		).toBe("green");
	});

	it("returns grey when all idle but workspace not opened", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("idle") },
				new Set(),
			),
		).toBe("grey");
	});

	it("error takes priority over active", () => {
		const layout: PaneNode = {
			type: "split",
			id: "s",
			direction: "horizontal",
			ratio: 0.5,
			first: { type: "terminal", id: "p1", ptyId: "pty-1" },
			second: { type: "terminal", id: "p2", ptyId: "pty-2" },
		};
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{
					"pty-1": makeEntry("error"),
					"pty-2": makeEntry("active"),
				},
				new Set(),
			),
		).toBe("red");
	});

	it("ready takes priority over active", () => {
		const layout: PaneNode = {
			type: "split",
			id: "s",
			direction: "horizontal",
			ratio: 0.5,
			first: { type: "terminal", id: "p1", ptyId: "pty-1" },
			second: { type: "terminal", id: "p2", ptyId: "pty-2" },
		};
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{
					"pty-1": makeEntry("ready"),
					"pty-2": makeEntry("active"),
				},
				new Set(),
			),
		).toBe("purple");
	});
});

describe("computeTabDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: "shell",
		hookDriven: false,
	});

	const makeTab = (layoutJson: string): Tab => ({
		id: "t1",
		workspaceId: "s1",
		name: "Tab 1",
		layoutJson,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	});

	it("returns green for invalid JSON", () => {
		expect(computeTabDotStatus(makeTab("invalid"), {})).toBe("green");
	});

	it("returns blue when active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeTabDotStatus(makeTab(JSON.stringify(layout)), {
				"pty-1": makeEntry("active"),
			}),
		).toBe("amber");
	});

	it("returns green when all idle", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeTabDotStatus(makeTab(JSON.stringify(layout)), {
				"pty-1": makeEntry("idle"),
			}),
		).toBe("green");
	});
});

describe("computePtyDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: "shell",
		hookDriven: false,
	});

	it("returns green for unknown ptyId", () => {
		expect(computePtyDotStatus("unknown", {})).toBe("green");
	});

	it("returns blue for active", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("active") })).toBe(
			"amber",
		);
	});

	it("returns orange for ready", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("ready") })).toBe(
			"purple",
		);
	});

	it("returns red for error", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("error") })).toBe(
			"red",
		);
	});

	it("returns green for idle", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("idle") })).toBe(
			"green",
		);
	});
});

describe("detection mode", () => {
	it("initPty defaults to shell mode", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.detectionMode).toBe("shell");
	});

	it("initPty accepts explicit agent mode", () => {
		usePtyActivityStore.getState().initPty("pty-1", "agent");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.detectionMode).toBe("agent");
	});

	it("setAgentPty marks a PTY as agent mode", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		const state = usePtyActivityStore.getState();
		expect(state.agentPtyIds.has("pty-1")).toBe(true);
		expect(state.activities["pty-1"].detectionMode).toBe("agent");
	});

	it("setAgentPty is idempotent", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		expect(usePtyActivityStore.getState().agentPtyIds.size).toBe(1);
	});

	it("recordExitSuccess transitions to ready", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().recordOutput("pty-1");
		usePtyActivityStore.getState().recordExitSuccess("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"ready",
		);
	});

	it("recordOutput preserves detectionMode", () => {
		usePtyActivityStore.getState().initPty("pty-1", "agent");
		usePtyActivityStore.getState().recordOutput("pty-1");
		expect(
			usePtyActivityStore.getState().activities["pty-1"].detectionMode,
		).toBe("agent");
	});

	it("recordError preserves detectionMode", () => {
		usePtyActivityStore.getState().initPty("pty-1", "agent");
		usePtyActivityStore.getState().recordError("pty-1");
		expect(
			usePtyActivityStore.getState().activities["pty-1"].detectionMode,
		).toBe("agent");
	});

	it("clearAgentPty reverts agent mode to shell", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		usePtyActivityStore.getState().clearAgentPty("pty-1");
		const state = usePtyActivityStore.getState();
		expect(state.agentPtyIds.has("pty-1")).toBe(false);
		expect(state.activities["pty-1"].detectionMode).toBe("shell");
	});

	it("clearAgentPty is no-op for shell-mode PTY", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		const before = usePtyActivityStore.getState();
		usePtyActivityStore.getState().clearAgentPty("pty-1");
		const after = usePtyActivityStore.getState();
		expect(after.agentPtyIds).toBe(before.agentPtyIds);
	});

	it("clearAgentPty handles missing activity entry", () => {
		usePtyActivityStore.setState({
			agentPtyIds: new Set(["pty-orphan"]),
		});
		usePtyActivityStore.getState().clearAgentPty("pty-orphan");
		expect(usePtyActivityStore.getState().agentPtyIds.has("pty-orphan")).toBe(
			false,
		);
	});

	it("removePty cleans up agentPtyIds", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		usePtyActivityStore.getState().removePty("pty-1");
		expect(usePtyActivityStore.getState().agentPtyIds.has("pty-1")).toBe(false);
	});
});

describe("notifications on state transitions", () => {
	const mockSendNotification = vi.mocked(sendNotification);

	beforeEach(() => {
		mockSendNotification.mockClear();
	});

	it("sends notification when transitioning to error while app is unfocused", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		seedWorkspace("ws-1", "my-project");
		const { initPty, recordOutput, recordError, registerPane, setTitle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "bash");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordError("pty-1");

		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "my-project",
			body: "bash encountered an error",
			extra: {
				type: "pty",
				paneId: "pane-1",
				workspaceId: "ws-1",
				tabId: "tab-1",
			},
		});
		vi.restoreAllMocks();
	});

	it("sends notification when transitioning to ready while app is unfocused", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		seedWorkspace("ws-1", "my-project");
		const { initPty, recordOutput, recordExitSuccess, registerPane, setTitle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "zsh");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordExitSuccess("pty-1");

		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "my-project",
			body: "zsh is ready",
			extra: {
				type: "pty",
				paneId: "pane-1",
				workspaceId: "ws-1",
				tabId: "tab-1",
			},
		});
		vi.restoreAllMocks();
	});

	it("falls back to 'Abundio' when the originating workspace cannot be resolved", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		// workspaces store is empty — findPaneLocation returns ws-1 but lookup misses
		const { initPty, recordOutput, recordError, registerPane, setTitle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "bash");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordError("pty-1");

		expect(mockSendNotification).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Abundio" }),
		);
		vi.restoreAllMocks();
	});

	it("does not send notification when app is focused", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const { initPty, recordOutput, recordError } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordError("pty-1");

		expect(mockSendNotification).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("does not send notification when state does not change", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		const { initPty, recordError } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordError("pty-1");
		mockSendNotification.mockClear();

		// Record error again — state is already "error", no transition
		recordError("pty-1");

		expect(mockSendNotification).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("uses agent label when no title is available", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		const { initPty, setAgentPty, recordOutput, recordExitSuccess } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordExitSuccess("pty-1");

		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "Abundio",
			body: "Agent is ready",
			extra: { type: "pty" },
		});
		vi.restoreAllMocks();
	});

	it("does not send notification when blurred for less than the threshold", () => {
		focusMock.blurredMs = 1500;
		const { initPty, recordOutput, recordError } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordError("pty-1");

		expect(mockSendNotification).not.toHaveBeenCalled();
		focusMock.blurredMs = 10_000;
	});

	it("sends notification when blurred for more than the threshold", () => {
		focusMock.blurredMs = 4000;
		const { initPty, recordOutput, recordError } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordError("pty-1");

		expect(mockSendNotification).toHaveBeenCalled();
		focusMock.blurredMs = 10_000;
	});
});

describe("touchLastOutput", () => {
	it("updates getLastOutputAt without changing Zustand state", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().recordOutput("pty-1");
		const stateBefore = usePtyActivityStore.getState().activities["pty-1"];

		touchLastOutput("pty-1", 9999);

		// External map is updated
		expect(getLastOutputAt("pty-1")).toBe(9999);
		// Zustand state object is unchanged (no re-render)
		expect(usePtyActivityStore.getState().activities["pty-1"]).toBe(
			stateBefore,
		);
	});

	it("defaults to Date.now() when no timestamp provided", () => {
		const before = Date.now();
		touchLastOutput("pty-1");
		const after = Date.now();
		const ts = getLastOutputAt("pty-1");
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});

describe("hook-driven status", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: "shell",
		hookDriven: false,
	});

	const split = (): PaneNode => ({
		type: "split",
		id: "s",
		direction: "horizontal",
		ratio: 0.5,
		first: { type: "terminal", id: "p1", ptyId: "pty-1" },
		second: { type: "terminal", id: "p2", ptyId: "pty-2" },
	});

	it("applyHookEvent waiting sets waiting state and hookDriven", () => {
		const { initPty, applyHookEvent } = usePtyActivityStore.getState();
		initPty("pty-1");
		applyHookEvent("pty-1", "waiting");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.state).toBe("waiting");
		expect(entry.hookDriven).toBe(true);
	});

	it("markIdle does not clear waiting for an agent-mode pane", () => {
		const { initPty, setAgentPty, applyHookEvent, markIdle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		applyHookEvent("pty-1", "waiting");
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"waiting",
		);
	});

	it("markIdle clears a stale waiting on a terminal-mode pane", () => {
		// A pane left "waiting" after its agent exited (clearAgentPty reverts
		// detectionMode to "shell") must behave like a normal terminal again.
		const { initPty, applyHookEvent, markIdle } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		applyHookEvent("pty-1", "waiting"); // shell mode — no setAgentPty
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("applyHookEvent active clears waiting (user responded)", () => {
		const { initPty, applyHookEvent } = usePtyActivityStore.getState();
		initPty("pty-1");
		applyHookEvent("pty-1", "waiting");
		applyHookEvent("pty-1", "active");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("clearWaiting drops a waiting agent to idle, not active", () => {
		const { initPty, setAgentPty, applyHookEvent, clearWaiting } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		applyHookEvent("pty-1", "waiting");
		clearWaiting("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("clearWaiting is a no-op when the pane is not waiting", () => {
		const { initPty, recordOutput, clearWaiting } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		clearWaiting("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("clearActive transitions an active agent to idle", () => {
		const { initPty, setAgentPty, applyHookEvent, clearActive } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		applyHookEvent("pty-1", "active");
		clearActive("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("clearActive is a no-op for a shell-mode active PTY", () => {
		const { initPty, recordOutput, clearActive } =
			usePtyActivityStore.getState();
		initPty("pty-1"); // defaults to detectionMode: "shell"
		recordOutput("pty-1");
		clearActive("pty-1");
		// Shell-mode active state must not be cancellable by the agent cancel
		// path — only markIdle (focus/click) clears it.
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
	});

	it("clearActive is a no-op when the agent is not active", () => {
		const { initPty, setAgentPty, applyHookEvent, clearActive } =
			usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		applyHookEvent("pty-1", "waiting");
		clearActive("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"waiting",
		);
	});

	it("applyHookEvent is a no-op for an unknown ptyId", () => {
		usePtyActivityStore.getState().applyHookEvent("ghost", "ready");
		expect(usePtyActivityStore.getState().activities.ghost).toBeUndefined();
	});

	it("computePtyDotStatus maps waiting to skyblue", () => {
		expect(
			computePtyDotStatus("pty-1", { "pty-1": makeEntry("waiting") }),
		).toBe("skyblue");
	});

	it("waiting takes priority over ready and active", () => {
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[split()],
				{
					"pty-1": makeEntry("waiting"),
					"pty-2": makeEntry("ready"),
				},
				new Set(),
			),
		).toBe("skyblue");
	});

	it("error takes priority over waiting", () => {
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[split()],
				{
					"pty-1": makeEntry("error"),
					"pty-2": makeEntry("waiting"),
				},
				new Set(),
			),
		).toBe("red");
	});
});

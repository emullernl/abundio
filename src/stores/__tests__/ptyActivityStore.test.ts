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
	selectErrorAgentCount,
	selectErrorShellCount,
	selectIdleAgentCount,
	selectIdleShellCount,
	selectReadyAgentCount,
	selectWaitingAgentCount,
	selectWorkingAgentCount,
	selectWorkingShellCount,
	setShellCommandRunning,
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
		profileId: "p-default",
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

	it("markIdle does not override active state while a shell command is running", () => {
		const { initPty, recordOutput, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		setShellCommandRunning("pty-1", true);
		// Workspace-switch focus reassertion / mousedown / keystroke must not
		// flip a long-running shell command's dot back to idle.
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
		// And once the command actually finishes, markIdle works again.
		setShellCommandRunning("pty-1", false);
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
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
	const makeEntry = (
		state: string,
		mode: "agent" | "shell" = "shell",
	): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: mode,
		hookDriven: false,
	});

	it("returns grey when no ptyIds", () => {
		expect(computeWorkspaceDotStatus("s1", [], {}, new Set())).toBe("grey");
	});

	it("returns red when any PTY is in error (shell or agent — Error always propagates)", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("error", "shell") },
				new Set(),
			),
		).toBe("red");
	});

	it("returns amber when an agent-mode PTY is active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("active", "agent") },
				new Set(),
			),
		).toBe("amber");
	});

	it("does NOT roll up a shell-mode active to amber — shell Working stays at the pane (ADR-0009)", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		// Workspace is opened (in the set) so the green/grey fallback returns green.
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("active", "shell") },
				new Set(["s1"]),
			),
		).toBe("green");
	});

	it("returns purple when an agent-mode PTY is ready", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeWorkspaceDotStatus(
				"s1",
				[layout],
				{ "pty-1": makeEntry("ready", "agent") },
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

	it("error takes priority over active across agent-mode panes", () => {
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
					"pty-1": makeEntry("error", "agent"),
					"pty-2": makeEntry("active", "agent"),
				},
				new Set(),
			),
		).toBe("red");
	});

	it("a shell-mode error still rolls up over an agent in active state", () => {
		// Confirms shell Error breaks through even when an agent is busy.
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
					"pty-1": makeEntry("error", "shell"),
					"pty-2": makeEntry("active", "agent"),
				},
				new Set(),
			),
		).toBe("red");
	});

	it("agent activity overrides a backgrounded shell command's would-be amber", () => {
		// [agent: active, shell: active] — only the agent contributes to the
		// rollup, but its active state is what the user sees.
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
					"pty-1": makeEntry("active", "agent"),
					"pty-2": makeEntry("active", "shell"),
				},
				new Set(),
			),
		).toBe("amber");
	});

	it("ready takes priority over active across agent-mode panes", () => {
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
					"pty-1": makeEntry("ready", "agent"),
					"pty-2": makeEntry("active", "agent"),
				},
				new Set(),
			),
		).toBe("purple");
	});
});

describe("computeTabDotStatus", () => {
	const makeEntry = (
		state: string,
		mode: "agent" | "shell" = "shell",
	): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: mode,
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

	it("returns amber when an agent-mode PTY is active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeTabDotStatus(makeTab(JSON.stringify(layout)), {
				"pty-1": makeEntry("active", "agent"),
			}),
		).toBe("amber");
	});

	it("returns green when a shell-mode PTY is running a command — Working doesn't propagate (ADR-0009)", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeTabDotStatus(makeTab(JSON.stringify(layout)), {
				"pty-1": makeEntry("active", "shell"),
			}),
		).toBe("green");
	});

	it("returns red when a shell-mode PTY errored — Error always propagates", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(
			computeTabDotStatus(makeTab(JSON.stringify(layout)), {
				"pty-1": makeEntry("error", "shell"),
			}),
		).toBe("red");
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
	const makeEntry = (
		state: string,
		mode: "agent" | "shell" = "shell",
	): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: mode,
		hookDriven: false,
	});

	it("returns green for unknown ptyId", () => {
		expect(computePtyDotStatus("unknown", {})).toBe("green");
	});

	it("returns amber for an agent-mode active PTY (mid-turn)", () => {
		expect(
			computePtyDotStatus("pty-1", {
				"pty-1": makeEntry("active", "agent"),
			}),
		).toBe("amber");
	});

	it("returns cyan for a shell-mode active PTY (running a command) — ADR-0009", () => {
		expect(
			computePtyDotStatus("pty-1", {
				"pty-1": makeEntry("active", "shell"),
			}),
		).toBe("cyan");
	});

	it("returns purple for ready", () => {
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

	it("recordExitSuccess transitions an agent-mode PTY to ready", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().setAgentPty("pty-1");
		usePtyActivityStore.getState().recordOutput("pty-1");
		usePtyActivityStore.getState().recordExitSuccess("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"ready",
		);
	});

	it("recordExitSuccess transitions a shell-mode PTY straight to idle (skips ready)", () => {
		// Shells skip the Ready hop entirely — a clean command exit is silent.
		// See ADR-0009.
		usePtyActivityStore.getState().initPty("pty-1");
		usePtyActivityStore.getState().recordOutput("pty-1");
		usePtyActivityStore.getState().recordExitSuccess("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"idle",
		);
	});

	it("recordOutput preserves detectionMode", () => {
		usePtyActivityStore.getState().initPty("pty-1", "agent");
		usePtyActivityStore.getState().recordOutput("pty-1");
		expect(
			usePtyActivityStore.getState().activities["pty-1"].detectionMode,
		).toBe("agent");
	});

	it("recordOutput does not stomp an agent-mode waiting dot", () => {
		// A permission prompt's own render output flows through recordOutput; it
		// must NOT pull the sky-blue Waiting dot back to active. Cleared only by
		// a keystroke or the next hook. See ADR-0015.
		usePtyActivityStore.getState().initPty("pty-1", "agent");
		usePtyActivityStore.getState().applyHookEvent("pty-1", "waiting");
		usePtyActivityStore.getState().recordOutput("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"waiting",
		);
	});

	it("recordOutput still clears a waiting dot in shell mode (guard is agent-only)", () => {
		// A stale "waiting" on a terminal-mode pane falls through to normal
		// output handling — the guard only protects agent-mode panes.
		usePtyActivityStore.getState().initPty("pty-1", "shell");
		usePtyActivityStore.getState().applyHookEvent("pty-1", "waiting");
		usePtyActivityStore.getState().recordOutput("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"active",
		);
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

		// Title now uses profile-qualified format (ADR-0007 follow-up); since
		// no profile is loaded in this test, currentNotificationTitle falls
		// back to plain "Abundio". The workspace name moved into the body so
		// the context isn't lost.
		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "Abundio",
			body: "my-project: bash encountered an error",
			extra: {
				type: "pty",
				paneId: "pane-1",
				workspaceId: "ws-1",
				tabId: "tab-1",
			},
		});
		vi.restoreAllMocks();
	});

	it("sends notification when an agent transitions to ready while app is unfocused", () => {
		// Shells skip Ready entirely (ADR-0009), so only agents reach this
		// notification path. Set the PTY to agent-mode so recordExitSuccess
		// routes through "ready" instead of "idle".
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		seedWorkspace("ws-1", "my-project");
		const {
			initPty,
			setAgentPty,
			recordOutput,
			recordExitSuccess,
			registerPane,
			setTitle,
		} = usePtyActivityStore.getState();
		initPty("pty-1");
		setAgentPty("pty-1");
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "claude");
		recordOutput("pty-1");
		mockSendNotification.mockClear();

		recordExitSuccess("pty-1");

		expect(mockSendNotification).toHaveBeenCalledWith({
			title: "Abundio",
			body: "my-project: claude is ready",
			extra: {
				type: "pty",
				paneId: "pane-1",
				workspaceId: "ws-1",
				tabId: "tab-1",
			},
		});
		vi.restoreAllMocks();
	});

	it("does not send notification when a shell-mode PTY exits cleanly (success is silent)", () => {
		// ADR-0009: shell-mode recordExitSuccess routes to "idle", which is
		// not a notification state. No notification should fire.
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

		expect(mockSendNotification).not.toHaveBeenCalled();
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
	// Hook-driven states (Waiting, Ready) only originate from Agent hooks, so
	// fixtures default to agent-mode — that's the realistic detectionMode at
	// the point a hook event lands. Tests that exercise the shell path
	// override mode explicitly.
	const makeEntry = (
		state: string,
		mode: "agent" | "shell" = "agent",
	): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
		detectionMode: mode,
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

	describe("Agent count selectors", () => {
		it("count only agent-mode PTYs (shell PTYs are ignored)", () => {
			const state = {
				agentPtyIds: new Set(["pty-1", "pty-2"]),
				activities: {
					"pty-1": makeEntry("active"),
					"pty-2": makeEntry("waiting"),
					// Shell PTY in active state — must NOT be counted as a Working agent
					"pty-shell": makeEntry("active"),
				},
			};
			expect(selectWorkingAgentCount(state)).toBe(1);
			expect(selectWaitingAgentCount(state)).toBe(1);
		});

		it("returns zero for states with no matching agents", () => {
			const state = {
				agentPtyIds: new Set(["pty-1"]),
				activities: { "pty-1": makeEntry("idle") },
			};
			expect(selectErrorAgentCount(state)).toBe(0);
			expect(selectReadyAgentCount(state)).toBe(0);
			expect(selectWaitingAgentCount(state)).toBe(0);
			expect(selectIdleAgentCount(state)).toBe(1);
		});

		it("buckets a mix of agent states", () => {
			const state = {
				agentPtyIds: new Set(["a", "b", "c", "d", "e", "f", "g"]),
				activities: {
					a: makeEntry("idle"),
					b: makeEntry("idle"),
					c: makeEntry("active"),
					d: makeEntry("waiting"),
					e: makeEntry("ready"),
					f: makeEntry("ready"),
					g: makeEntry("error"),
				},
			};
			expect(selectIdleAgentCount(state)).toBe(2);
			expect(selectWorkingAgentCount(state)).toBe(1);
			expect(selectWaitingAgentCount(state)).toBe(1);
			expect(selectReadyAgentCount(state)).toBe(2);
			expect(selectErrorAgentCount(state)).toBe(1);
		});

		it("ignores agent ids whose activity entry is missing", () => {
			// agentPtyIds can momentarily list a pty that hasn't been initPty'd yet
			const state = {
				agentPtyIds: new Set(["pty-1", "ghost"]),
				activities: { "pty-1": makeEntry("active") },
			};
			expect(selectWorkingAgentCount(state)).toBe(1);
		});
	});

	describe("Shell count selectors", () => {
		it("count only shell-mode PTYs (agent PTYs are ignored)", () => {
			const state = {
				agentPtyIds: new Set(["pty-agent"]),
				activities: {
					"pty-agent": makeEntry("active"),
					"pty-shell-1": makeEntry("active"),
					"pty-shell-2": makeEntry("idle"),
				},
			};
			// Agent in active state must NOT count as a Working shell
			expect(selectWorkingShellCount(state)).toBe(1);
			expect(selectIdleShellCount(state)).toBe(1);
		});

		it("buckets a mix of shell states (no Ready selector — shells skip Ready per ADR-0009)", () => {
			const state = {
				agentPtyIds: new Set<string>(),
				activities: {
					a: makeEntry("idle"),
					b: makeEntry("active"),
					c: makeEntry("active"),
					e: makeEntry("error"),
				},
			};
			expect(selectIdleShellCount(state)).toBe(1);
			expect(selectWorkingShellCount(state)).toBe(2);
			expect(selectErrorShellCount(state)).toBe(1);
		});

		it("returns zero when all PTYs are agent-mode", () => {
			const state = {
				agentPtyIds: new Set(["a", "b"]),
				activities: {
					a: makeEntry("active"),
					b: makeEntry("idle"),
				},
			};
			expect(selectIdleShellCount(state)).toBe(0);
			expect(selectWorkingShellCount(state)).toBe(0);
		});
	});
});

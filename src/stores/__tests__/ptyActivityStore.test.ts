import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../../lib/types";
import {
	backstopRule,
	collectPtyIds,
	computePtyDotStatus,
	computeTabDotStatus,
	computeWorkspaceDotStatus,
	dotStatusLabel,
	getLastOutputAt,
	type PtyActivityEntry,
	peekPreErrorState,
	rollupDotStatus,
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
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p-default",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
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
		vi.setSystemTime(5000);
		usePtyActivityStore.getState().recordOutput("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe(
			"waiting",
		);
		// The guard must still bump the out-of-band timestamp so the idle-scanner
		// backstop won't eventually time the Waiting dot out — guards against a
		// regression that drops the lastOutputTimestamps.set(...) line.
		expect(getLastOutputAt("pty-1")).toBe(5000);
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

// The Overview bar counts are derived live by iterating activities/agentPtyIds.
// teardownTerminal's store effect is removePty(ptyId) + removePane(paneId); these
// tests lock that closing a pane drops its count and never underflows. See ADR-0020.
describe("Overview bar counts drop when a pane is torn down", () => {
	function seedFourPanes() {
		const s = usePtyActivityStore.getState();
		// agent working
		s.initPty("a1", "agent");
		s.setAgentPty("a1");
		s.recordOutput("a1");
		s.registerPane("pane-a1", "a1");
		// agent idle
		s.initPty("a2", "agent");
		s.setAgentPty("a2");
		s.registerPane("pane-a2", "a2");
		// shell working
		s.initPty("s1");
		s.recordOutput("s1");
		s.registerPane("pane-s1", "s1");
		// shell error
		s.initPty("s2");
		s.recordError("s2");
		s.registerPane("pane-s2", "s2");
	}

	it("dropping an agent and a shell pane decrements only their tiles", () => {
		seedFourPanes();
		expect(selectWorkingAgentCount(usePtyActivityStore.getState())).toBe(1);
		expect(selectIdleAgentCount(usePtyActivityStore.getState())).toBe(1);
		expect(selectWorkingShellCount(usePtyActivityStore.getState())).toBe(1);
		expect(selectErrorShellCount(usePtyActivityStore.getState())).toBe(1);

		// Simulate teardownTerminal's store effect for the working agent + shell.
		const s = usePtyActivityStore.getState();
		s.removePty("a1");
		s.removePane("pane-a1");
		s.removePty("s1");
		s.removePane("pane-s1");

		const after = usePtyActivityStore.getState();
		expect(selectWorkingAgentCount(after)).toBe(0);
		expect(selectIdleAgentCount(after)).toBe(1); // a2 survives
		expect(selectWorkingShellCount(after)).toBe(0);
		expect(selectErrorShellCount(after)).toBe(1); // s2 survives
		expect(after.panePtyMap["pane-a1"]).toBeUndefined();
		expect(after.panePtyMap["pane-s1"]).toBeUndefined();
		expect(after.agentPtyIds.has("a1")).toBe(false);
	});

	it("is idempotent — a redundant teardown pass can't underflow the counts", () => {
		seedFourPanes();
		const s = usePtyActivityStore.getState();
		s.removePty("a1");
		s.removePane("pane-a1");
		// Second pass (the closePaneNow→closeTab cascade) is a no-op.
		s.removePty("a1");
		s.removePane("pane-a1");

		const after = usePtyActivityStore.getState();
		expect(selectWorkingAgentCount(after)).toBe(0);
		expect(selectIdleAgentCount(after)).toBe(1);
		expect(selectWorkingShellCount(after)).toBe(1);
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

describe("mid-turn failure (ADR-0026)", () => {
	const mockSendNotification = vi.mocked(sendNotification);

	beforeEach(() => {
		mockSendNotification.mockClear();
	});

	it("survives the dispatch round-trip and restores Working", () => {
		// The regression that matters: `preErrorState` lives outside the Zustand
		// entry, so without the hydrate/applyStatusEvent mirroring the reducer
		// change is a silent no-op — each dispatch rebuilds StatusState from
		// scratch and the memory would be gone by the time clearError runs.
		const s = usePtyActivityStore.getState();
		s.initPty("pty-mt", "agent");
		s.setAgentPty("pty-mt", "copilot");
		s.applyHookEvent("pty-mt", "active");
		s.applyHookEvent("pty-mt", "errorMidTurn");
		expect(usePtyActivityStore.getState().activities["pty-mt"].state).toBe(
			"error",
		);
		expect(peekPreErrorState("pty-mt")).toBe("working");

		s.clearError("pty-mt");
		expect(usePtyActivityStore.getState().activities["pty-mt"].state).toBe(
			"active",
		);
		expect(peekPreErrorState("pty-mt")).toBeNull();
	});

	it("a Turn failure still acknowledges to idle", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-tf", "agent");
		s.setAgentPty("pty-tf", "claude");
		s.applyHookEvent("pty-tf", "active");
		s.applyHookEvent("pty-tf", "error");
		expect(peekPreErrorState("pty-tf")).toBeNull();
		s.clearError("pty-tf");
		expect(usePtyActivityStore.getState().activities["pty-tf"].state).toBe(
			"idle",
		);
	});

	it("a second mid-turn failure keeps the memory despite emitting no StatusChange", () => {
		// The asymmetry worth pinning: the projected entry is identical across the
		// second failure (error → error, same mode/hookDriven), so `changed` is
		// false and no StatusChange fires — but the out-of-band preErrorStates map
		// syncs *before* that check, so a regression here is invisible at the
		// entry layer and only shows up when the user acknowledges.
		const s = usePtyActivityStore.getState();
		s.initPty("pty-2mt", "agent");
		s.setAgentPty("pty-2mt", "copilot");
		s.applyHookEvent("pty-2mt", "active");
		s.applyHookEvent("pty-2mt", "errorMidTurn");
		s.applyHookEvent("pty-2mt", "errorMidTurn");
		expect(peekPreErrorState("pty-2mt")).toBe("working");

		s.clearError("pty-2mt");
		expect(usePtyActivityStore.getState().activities["pty-2mt"].state).toBe(
			"active",
		);
	});

	it("removePty and a re-init drop the memory", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-rm", "agent");
		s.setAgentPty("pty-rm", "copilot");
		s.applyHookEvent("pty-rm", "active");
		s.applyHookEvent("pty-rm", "errorMidTurn");
		expect(peekPreErrorState("pty-rm")).toBe("working");

		usePtyActivityStore.getState().removePty("pty-rm");
		expect(peekPreErrorState("pty-rm")).toBeNull();

		// A reused ptyId must not inherit it either.
		usePtyActivityStore.getState().initPty("pty-rm", "agent");
		expect(peekPreErrorState("pty-rm")).toBeNull();
	});

	it("does not notify — the Agent is still working and agentStop will follow", () => {
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		seedWorkspace("ws-1", "my-project");
		const s = usePtyActivityStore.getState();
		s.initPty("pty-nt", "agent");
		s.setAgentPty("pty-nt", "copilot");
		s.registerPane("pane-nt", "pty-nt");
		s.applyHookEvent("pty-nt", "active");
		mockSendNotification.mockClear();

		usePtyActivityStore.getState().applyHookEvent("pty-nt", "errorMidTurn");
		expect(mockSendNotification).not.toHaveBeenCalled();

		// …but a Turn failure on the same pane still pings. (Acknowledge first:
		// error → error is not a transition, so it would emit nothing at all.)
		usePtyActivityStore.getState().clearError("pty-nt");
		expect(mockSendNotification).not.toHaveBeenCalled();
		usePtyActivityStore.getState().applyHookEvent("pty-nt", "error");
		expect(mockSendNotification).toHaveBeenCalledTimes(1);
	});
});

describe("backstopRule (ADR-0027)", () => {
	it("calls a silent pane's backstop a presumed end", () => {
		expect(backstopRule({ activeSubagents: [] })).toBe("idle_backstop");
	});

	it("calls a pane with live Subagents a drain", () => {
		// There a turn-finished hook WAS observed and merely held (ADR-0022), so
		// the boundary is not presumed — only its timing is fuzzy.
		expect(
			backstopRule({ activeSubagents: [{ id: "sa-1", startedAt: 0 }] }),
		).toBe("subagent_drain");
	});
});

describe("the click action", () => {
	it("leaves a Waiting restored from a Mid-turn failure waiting", () => {
		// THE regression. A click used to be three dispatches from two different
		// handlers — terminalManager's native mousedown listener (clearError then
		// markIdle) fired before TerminalSlot's React onMouseDown (clearWaiting),
		// because a listener on a descendant beats React's root-delegated handler.
		// That inverted the reducer's clearWaiting-first order: clearError restored
		// Waiting and the trailing clearWaiting immediately wiped it to Idle. So a
		// Mid-turn failure raised while the pane was Working acknowledged correctly,
		// but one raised while it was Waiting silently dropped to Idle mid-Turn.
		const s = usePtyActivityStore.getState();
		s.initPty("pty-cw", "agent");
		s.setAgentPty("pty-cw", "copilot");
		s.applyHookEvent("pty-cw", "active");
		s.applyHookEvent("pty-cw", "waiting");
		s.applyHookEvent("pty-cw", "errorMidTurn");
		expect(peekPreErrorState("pty-cw")).toBe("waiting");

		usePtyActivityStore.getState().click("pty-cw");
		expect(usePtyActivityStore.getState().activities["pty-cw"].state).toBe(
			"waiting",
		);
		expect(peekPreErrorState("pty-cw")).toBeNull();
	});

	it("restores Working from a Mid-turn failure raised while Working", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-cwk", "agent");
		s.setAgentPty("pty-cwk", "copilot");
		s.applyHookEvent("pty-cwk", "active");
		s.applyHookEvent("pty-cwk", "errorMidTurn");

		usePtyActivityStore.getState().click("pty-cwk");
		expect(usePtyActivityStore.getState().activities["pty-cwk"].state).toBe(
			"active",
		);
	});

	it("still dismisses a plain Waiting pane to idle (PR #140)", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-cpw", "agent");
		s.setAgentPty("pty-cpw", "copilot");
		s.applyHookEvent("pty-cpw", "waiting");

		usePtyActivityStore.getState().click("pty-cpw");
		expect(usePtyActivityStore.getState().activities["pty-cpw"].state).toBe(
			"idle",
		);
	});

	it("dismisses Ready, and rests a Turn failure at idle", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-cr", "agent");
		s.setAgentPty("pty-cr", "claude");
		s.applyHookEvent("pty-cr", "ready");
		usePtyActivityStore.getState().click("pty-cr");
		expect(usePtyActivityStore.getState().activities["pty-cr"].state).toBe(
			"idle",
		);

		s.applyHookEvent("pty-cr", "active");
		s.applyHookEvent("pty-cr", "error");
		usePtyActivityStore.getState().click("pty-cr");
		expect(usePtyActivityStore.getState().activities["pty-cr"].state).toBe(
			"idle",
		);
	});

	it("never cancels a Working agent", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("pty-cwork", "agent");
		s.setAgentPty("pty-cwork", "copilot");
		s.applyHookEvent("pty-cwork", "active");

		usePtyActivityStore.getState().click("pty-cwork");
		expect(usePtyActivityStore.getState().activities["pty-cwork"].state).toBe(
			"active",
		);
	});
});

// The Hidden rollup a Folded set's Primary row shows for the Linked worktrees
// it hides — see the "Hidden rollup" entry in CONTEXT.md.
describe("rollupDotStatus", () => {
	it("returns grey for no members", () => {
		expect(rollupDotStatus([])).toBe("grey");
	});

	it("passes a single member's status through unchanged", () => {
		for (const status of [
			"red",
			"skyblue",
			"purple",
			"amber",
			"cyan",
			"green",
			"grey",
		] as const) {
			expect(rollupDotStatus([status])).toBe(status);
		}
	});

	it("picks the highest-attention status", () => {
		expect(rollupDotStatus(["green", "amber", "grey"])).toBe("amber");
		expect(rollupDotStatus(["amber", "purple"])).toBe("purple");
		expect(rollupDotStatus(["purple", "skyblue"])).toBe("skyblue");
		expect(rollupDotStatus(["skyblue", "red"])).toBe("red");
		expect(rollupDotStatus(["grey", "green"])).toBe("green");
	});

	it("agrees with computeWorkspaceDotStatus's own precedence", () => {
		// Two workspaces, one waiting and one working: rolling up their computed
		// statuses must match what a single workspace holding both PTYs reports.
		const waitingPane: PaneNode = { type: "terminal", id: "p1", ptyId: "a" };
		const workingPane: PaneNode = { type: "terminal", id: "p2", ptyId: "b" };
		const agentEntry = (
			state: PtyActivityEntry["state"],
		): PtyActivityEntry => ({
			state,
			lastOutputAt: null,
			hasEverReceivedOutput: true,
			detectionMode: "agent",
			hookDriven: false,
		});
		const activities: Record<string, PtyActivityEntry> = {
			a: agentEntry("waiting"),
			b: agentEntry("active"),
		};
		const opened = new Set(["ws-a", "ws-b", "ws-both"]);
		const separate = rollupDotStatus([
			computeWorkspaceDotStatus("ws-a", [waitingPane], activities, opened),
			computeWorkspaceDotStatus("ws-b", [workingPane], activities, opened),
		]);
		const combined = computeWorkspaceDotStatus(
			"ws-both",
			[
				{
					type: "split",
					id: "s",
					direction: "horizontal",
					ratio: 0.5,
					first: waitingPane,
					second: workingPane,
				},
			],
			activities,
			opened,
		);
		expect(separate).toBe(combined);
	});
});

describe("dotStatusLabel", () => {
	it("labels every status", () => {
		expect(dotStatusLabel("red")).toBe("Error");
		expect(dotStatusLabel("skyblue")).toBe("Waiting");
		expect(dotStatusLabel("purple")).toBe("Ready");
		expect(dotStatusLabel("amber")).toBe("Working");
		expect(dotStatusLabel("cyan")).toBe("Shell running");
		expect(dotStatusLabel("green")).toBe("Idle");
		expect(dotStatusLabel("grey")).toBe("Not opened");
	});
});

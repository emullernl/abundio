import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/workspaceStore", () => ({
	useWorkspaceStore: {
		getState: vi.fn(() => ({ workspaces: [], closeWorkspace: vi.fn() })),
	},
}));

vi.mock("../../stores/ptyActivityStore", async () => {
	const actual = await vi.importActual<
		typeof import("../../stores/ptyActivityStore")
	>("../../stores/ptyActivityStore");
	return {
		collectPtyIds: actual.collectPtyIds,
		isShellCommandRunning: vi.fn(() => false),
		usePtyActivityStore: {
			getState: vi.fn(() => ({ activities: {}, panePtyMap: {} })),
		},
	};
});

import type { PaneNode } from "../../lib/types";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	buildUnloadWorkspaceMessage,
	detectWorkForWorkspace,
	detectWorkInLayout,
} from "../useConfirmUnloadWorkspace";

function layoutJson(node: PaneNode): string {
	return JSON.stringify(node);
}

const terminal = (id: string, ptyId: string): PaneNode => ({
	type: "terminal",
	id,
	ptyId,
});

const NONE = { hasWorkingAgent: false, hasRunningCommand: false };

describe("detectWorkInLayout", () => {
	it("returns no signals for an idle terminal", () => {
		const signals = detectWorkInLayout(
			layoutJson(terminal("pane-1", "pty-1")),
			() => false,
			() => false,
			{},
		);
		expect(signals).toEqual(NONE);
	});

	it("detects a Working agent", () => {
		const signals = detectWorkInLayout(
			layoutJson(terminal("pane-1", "pty-1")),
			(id) => id === "pty-1",
			() => false,
			{},
		);
		expect(signals).toEqual({
			hasWorkingAgent: true,
			hasRunningCommand: false,
		});
	});

	it("does NOT treat a non-working (e.g. Waiting) agent as work", () => {
		// The Working predicate is the only agent gate — a Waiting agent yields
		// false here, mirroring how detectWorkForWorkspace builds it.
		const signals = detectWorkInLayout(
			layoutJson(terminal("pane-1", "pty-1")),
			() => false,
			() => false,
			{},
		);
		expect(signals).toEqual(NONE);
	});

	it("detects a running shell command", () => {
		const signals = detectWorkInLayout(
			layoutJson(terminal("pane-1", "pty-1")),
			() => false,
			(id) => id === "pty-1",
			{},
		);
		expect(signals).toEqual({
			hasWorkingAgent: false,
			hasRunningCommand: true,
		});
	});

	it("detects both when a split has a Working agent and a running command", () => {
		const layout: PaneNode = {
			type: "split",
			id: "split-1",
			direction: "horizontal",
			ratio: 0.5,
			first: terminal("pane-1", "pty-agent"),
			second: terminal("pane-2", "pty-busy"),
		};
		const signals = detectWorkInLayout(
			layoutJson(layout),
			(id) => id === "pty-agent",
			(id) => id === "pty-busy",
			{},
		);
		expect(signals).toEqual({ hasWorkingAgent: true, hasRunningCommand: true });
	});

	it("falls back to panePtyMap when node.ptyId is empty", () => {
		const signals = detectWorkInLayout(
			layoutJson(terminal("pane-1", "")),
			(id) => id === "pty-from-map",
			() => false,
			{ "pane-1": "pty-from-map" },
		);
		expect(signals).toEqual({
			hasWorkingAgent: true,
			hasRunningCommand: false,
		});
	});

	it("returns no signals on malformed layoutJson", () => {
		const signals = detectWorkInLayout(
			"not-json",
			() => true,
			() => true,
			{},
		);
		expect(signals).toEqual(NONE);
	});
});

describe("detectWorkForWorkspace", () => {
	const entry = (
		state: PtyActivityEntry["state"],
		mode: PtyActivityEntry["detectionMode"],
	): PtyActivityEntry => ({
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode: mode,
		hookDriven: false,
	});

	it("returns no signals for a missing workspace id", async () => {
		const { useWorkspaceStore } = await import("../../stores/workspaceStore");
		vi.mocked(useWorkspaceStore.getState).mockReturnValue({
			workspaces: [],
			closeWorkspace: vi.fn(),
		} as never);
		expect(detectWorkForWorkspace("nope")).toEqual(NONE);
	});

	it("only counts an agent in the Working ('active' + agent) state", async () => {
		const { usePtyActivityStore } = await import(
			"../../stores/ptyActivityStore"
		);
		vi.mocked(useWorkspaceStore.getState).mockReturnValue({
			workspaces: [
				{
					id: "ws-1",
					tabs: [{ layoutJson: layoutJson(terminal("p", "pty-a")) }],
				},
			],
			closeWorkspace: vi.fn(),
		} as never);

		// Waiting agent → no signal.
		vi.mocked(usePtyActivityStore.getState).mockReturnValue({
			activities: { "pty-a": entry("waiting", "agent") },
			panePtyMap: {},
		} as never);
		expect(detectWorkForWorkspace("ws-1")).toEqual(NONE);

		// Working agent → signal.
		vi.mocked(usePtyActivityStore.getState).mockReturnValue({
			activities: { "pty-a": entry("active", "agent") },
			panePtyMap: {},
		} as never);
		expect(detectWorkForWorkspace("ws-1")).toEqual({
			hasWorkingAgent: true,
			hasRunningCommand: false,
		});

		// 'active' but shell-mode → not an agent, no signal.
		vi.mocked(usePtyActivityStore.getState).mockReturnValue({
			activities: { "pty-a": entry("active", "shell") },
			panePtyMap: {},
		} as never);
		expect(detectWorkForWorkspace("ws-1")).toEqual(NONE);
	});

	it("ORs Working signals across tabs (agent in one tab, command in another)", async () => {
		const { usePtyActivityStore, isShellCommandRunning } = await import(
			"../../stores/ptyActivityStore"
		);
		vi.mocked(useWorkspaceStore.getState).mockReturnValue({
			workspaces: [
				{
					id: "ws-1",
					tabs: [
						{ layoutJson: layoutJson(terminal("p1", "pty-agent")) },
						{ layoutJson: layoutJson(terminal("p2", "pty-busy")) },
					],
				},
			],
			closeWorkspace: vi.fn(),
		} as never);
		vi.mocked(usePtyActivityStore.getState).mockReturnValue({
			activities: { "pty-agent": entry("active", "agent") },
			panePtyMap: {},
		} as never);
		vi.mocked(isShellCommandRunning).mockImplementation(
			(id) => id === "pty-busy",
		);

		expect(detectWorkForWorkspace("ws-1")).toEqual({
			hasWorkingAgent: true,
			hasRunningCommand: true,
		});
	});
});

describe("buildUnloadWorkspaceMessage", () => {
	it("mentions only the agent when only an agent is working", () => {
		expect(
			buildUnloadWorkspaceMessage({
				hasWorkingAgent: true,
				hasRunningCommand: false,
			}),
		).toBe("An agent is still working in this workspace.");
	});

	it("mentions only the command when only a command is in progress", () => {
		expect(
			buildUnloadWorkspaceMessage({
				hasWorkingAgent: false,
				hasRunningCommand: true,
			}),
		).toBe("A command is still in progress in this workspace.");
	});

	it("mentions both when both are present", () => {
		expect(
			buildUnloadWorkspaceMessage({
				hasWorkingAgent: true,
				hasRunningCommand: true,
			}),
		).toBe(
			"An agent is still working and a command is in progress in this workspace.",
		);
	});
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/workspaceStore", () => ({
	useWorkspaceStore: {
		getState: vi.fn(() => ({ workspaces: [], closeTab: vi.fn() })),
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
			getState: vi.fn(() => ({
				agentPtyIds: new Set(),
				panePtyMap: {},
			})),
		},
	};
});

import type { PaneNode } from "../../lib/types";
import {
	buildCloseTerminalMessage,
	detectRunningInLayout,
} from "../useConfirmCloseTerminalTab";

function layoutJson(node: PaneNode): string {
	return JSON.stringify(node);
}

describe("detectRunningInLayout", () => {
	it("returns no signals for an idle terminal", () => {
		const layout: PaneNode = {
			type: "terminal",
			id: "pane-1",
			ptyId: "pty-1",
		};
		const signals = detectRunningInLayout(
			layoutJson(layout),
			new Set(),
			{},
			() => false,
		);
		expect(signals).toEqual({ hasAgent: false, hasCommand: false });
	});

	it("detects agent via agentPtyIds", () => {
		const layout: PaneNode = {
			type: "terminal",
			id: "pane-1",
			ptyId: "pty-1",
		};
		const signals = detectRunningInLayout(
			layoutJson(layout),
			new Set(["pty-1"]),
			{},
			() => false,
		);
		expect(signals).toEqual({ hasAgent: true, hasCommand: false });
	});

	it("detects running shell command", () => {
		const layout: PaneNode = {
			type: "terminal",
			id: "pane-1",
			ptyId: "pty-1",
		};
		const signals = detectRunningInLayout(
			layoutJson(layout),
			new Set(),
			{},
			(id) => id === "pty-1",
		);
		expect(signals).toEqual({ hasAgent: false, hasCommand: true });
	});

	it("detects both when a split has an agent and a running command", () => {
		const layout: PaneNode = {
			type: "split",
			id: "split-1",
			direction: "horizontal",
			ratio: 0.5,
			first: { type: "terminal", id: "pane-1", ptyId: "pty-agent" },
			second: { type: "terminal", id: "pane-2", ptyId: "pty-busy" },
		};
		const signals = detectRunningInLayout(
			layoutJson(layout),
			new Set(["pty-agent"]),
			{},
			(id) => id === "pty-busy",
		);
		expect(signals).toEqual({ hasAgent: true, hasCommand: true });
	});

	it("falls back to panePtyMap when node.ptyId is empty", () => {
		const layout: PaneNode = { type: "terminal", id: "pane-1", ptyId: "" };
		const signals = detectRunningInLayout(
			layoutJson(layout),
			new Set(["pty-from-map"]),
			{ "pane-1": "pty-from-map" },
			() => false,
		);
		expect(signals).toEqual({ hasAgent: true, hasCommand: false });
	});

	it("returns no signals on malformed layoutJson", () => {
		const signals = detectRunningInLayout(
			"not-json",
			new Set(["pty-1"]),
			{},
			() => true,
		);
		expect(signals).toEqual({ hasAgent: false, hasCommand: false });
	});
});

describe("buildCloseTerminalMessage", () => {
	it("mentions only the agent when only agent is running", () => {
		expect(
			buildCloseTerminalMessage({ hasAgent: true, hasCommand: false }),
		).toBe("An agent is still running in this tab.");
	});

	it("mentions only the command when only a command is running", () => {
		expect(
			buildCloseTerminalMessage({ hasAgent: false, hasCommand: true }),
		).toBe("A command is still running in this tab.");
	});

	it("mentions both when both are running", () => {
		expect(
			buildCloseTerminalMessage({ hasAgent: true, hasCommand: true }),
		).toBe("An agent and a command are still running in this tab.");
	});
});

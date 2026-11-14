import { describe, expect, it, vi } from "vitest";

vi.mock("../terminalManager", () => ({}));

import { nextAgentPane } from "../agentCycle";
import type { FleetTile } from "../fleetConsole";

const tile = (paneId: string, workspaceId: string): FleetTile => ({
	paneId,
	ptyId: `pty-${paneId}`,
	workspaceId,
	tabId: "t",
	tabName: "Main",
});

// Handle order, across Workspaces.
const agents = [tile("p1", "b"), tile("p2", "a"), tile("p3", "b")];

describe("nextAgentPane", () => {
	it("steps from the focused Agent, wrapping at both ends", () => {
		expect(nextAgentPane(agents, "p1", "b", 1)).toBe("p2");
		expect(nextAgentPane(agents, "p3", "b", 1)).toBe("p1");
		expect(nextAgentPane(agents, "p1", "b", -1)).toBe("p3");
	});

	it("goes to the first (next) or last (previous) when no Agent is focused", () => {
		expect(nextAgentPane(agents, "shell", "b", 1)).toBe("p1");
		expect(nextAgentPane(agents, null, "b", -1)).toBe("p3");
	});

	it("ignores a focused pane that belongs to another Workspace", () => {
		expect(nextAgentPane(agents, "p2", "b", 1)).toBe("p1");
	});

	it("does nothing with no Agents", () => {
		expect(nextAgentPane([], null, "b", 1)).toBeNull();
	});
});

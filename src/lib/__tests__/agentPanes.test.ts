import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../terminalManager", () => ({}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	agentsInListOrderNow,
	groupByWorkspace,
	inListOrder,
} from "../agentPanes";
import type { FleetTile } from "../fleetConsole";
import type { WorkspaceWithTabs } from "../types";

const tile = (paneId: string, workspaceId: string): FleetTile => ({
	paneId,
	ptyId: `pty-${paneId}`,
	workspaceId,
	tabId: "t",
	tabName: "Main",
});

/** One Workspace whose single Tab holds the given panes, with handles. */
function ws(id: string, panes: [string, string][]): WorkspaceWithTabs {
	const layout = panes.reduceRight<unknown>(
		(second, [paneId, agentHandle]) =>
			second === null
				? { type: "terminal", id: paneId, ptyId: `pty-${paneId}`, agentHandle }
				: {
						type: "split",
						id: `s-${paneId}`,
						direction: "horizontal",
						ratio: 0.5,
						first: {
							type: "terminal",
							id: paneId,
							ptyId: `pty-${paneId}`,
							agentHandle,
						},
						second,
					},
		null,
	);
	return {
		id,
		name: id,
		tabs: [
			{ id: `${id}-t`, workspaceId: id, layoutJson: JSON.stringify(layout) },
		],
	} as unknown as WorkspaceWithTabs;
}

// Derived order: Workspace b before a in the sidebar.
const workspaces = [
	ws("a", [["a1", "Agent Two"]]),
	ws("b", [
		["b1", "Agent Ten"],
		["b2", "Agent Three"],
	]),
];
const tiles = [tile("b1", "b"), tile("b2", "b"), tile("a1", "a")];

describe("groupByWorkspace", () => {
	it("keeps the tiles' Workspace order and sorts by handle inside each", () => {
		expect(
			groupByWorkspace(tiles, workspaces).map((g) => [
				g.workspaceId,
				g.tiles.map((t) => t.paneId),
			]),
		).toEqual([
			["b", ["b2", "b1"]],
			["a", ["a1"]],
		]);
	});

	it("has no group for a Workspace without Agents", () => {
		expect(groupByWorkspace([], workspaces)).toEqual([]);
	});
});

describe("inListOrder", () => {
	it("grouped: Workspace by Workspace", () => {
		expect(inListOrder(tiles, workspaces, true).map((t) => t.paneId)).toEqual([
			"b2",
			"b1",
			"a1",
		]);
	});

	it("flat: Handle order across Workspaces", () => {
		expect(inListOrder(tiles, workspaces, false).map((t) => t.paneId)).toEqual([
			"a1",
			"b2",
			"b1",
		]);
	});
});

describe("agentsInListOrderNow (the Agent cycle's stops)", () => {
	it("follows the Agents list's grouped / flat setting", () => {
		useWorkspaceStore.setState({
			workspaces: [
				ws("a", [["a1", "Agent Ten"]]),
				ws("b", [["b1", "Agent Two"]]),
			],
		});
		const agent = { detectionMode: "agent" } as never;
		usePtyActivityStore.setState({
			openedWorkspaceIds: new Set(["a", "b"]),
			panePtyMap: {},
			activities: { "pty-a1": agent, "pty-b1": agent },
		});

		useSettingsStore.setState({ agentsListGrouped: true });
		expect(agentsInListOrderNow().map((t) => t.paneId)).toEqual(["a1", "b1"]);

		useSettingsStore.setState({ agentsListGrouped: false });
		expect(agentsInListOrderNow().map((t) => t.paneId)).toEqual(["b1", "a1"]);
	});
});

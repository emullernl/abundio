import { beforeEach, describe, expect, it, vi } from "vitest";

const tabUpdates: [string, unknown][] = [];
const closedPanes: string[] = [];
vi.mock("../ipc", () => ({
	agentControl: {
		paneClosed: async (paneId: string) => {
			closedPanes.push(paneId);
		},
	},
	tabs: {
		update: async (id: string, u: unknown) => {
			tabUpdates.push([id, u]);
		},
	},
}));
vi.mock("../terminalManager", () => ({ teardownTerminal: () => {} }));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { closePaneNow, releaseOwner } from "../closePane";
import type { PaneNode, WorkspaceWithTabs } from "../types";

const tree: PaneNode = {
	type: "split",
	id: "s",
	direction: "vertical",
	ratio: 0.5,
	first: { type: "terminal", id: "a", ptyId: "pa" },
	second: {
		type: "split",
		id: "s2",
		direction: "horizontal",
		ratio: 0.5,
		first: { type: "terminal", id: "b", ptyId: "pb", spawnedBy: "a" },
		second: { type: "terminal", id: "c", ptyId: "pc" },
	},
};
const other: PaneNode = {
	type: "terminal",
	id: "d",
	ptyId: "pd",
	spawnedBy: "a",
};

beforeEach(() => {
	tabUpdates.length = 0;
	closedPanes.length = 0;
	usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["ws"]) });
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws",
				tabs: [
					{
						id: "t1",
						workspaceId: "ws",
						name: "1",
						layoutJson: JSON.stringify(tree),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
					{
						id: "t2",
						workspaceId: "ws",
						name: "2",
						layoutJson: JSON.stringify(other),
						position: 1,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			} as unknown as WorkspaceWithTabs,
		],
		activeWorkspaceId: "ws",
		activeTabByWorkspace: { ws: "t1" },
		focusedPaneId: "c",
		focusedPaneByTab: {},
	} as never);
});

const tabJson = (id: string) =>
	useWorkspaceStore.getState().workspaces[0].tabs.find((t) => t.id === id)
		?.layoutJson ?? "";

describe("closePaneNow", () => {
	it("frees the closed pane's Spawned panes, in every Tab", async () => {
		await closePaneNow("a");
		expect(tabJson("t1")).not.toContain("spawnedBy");
		expect(tabJson("t2")).not.toContain("spawnedBy");
	});

	it("without keepFocus, focuses the first terminal as before", async () => {
		await closePaneNow("b");
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("a");
	});

	it("with keepFocus, leaves focus on another open pane", async () => {
		await closePaneNow("b", { keepFocus: true });
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("c");
	});
});

describe("renameTab", () => {
	it("renames, in the store and the database", async () => {
		await useWorkspaceStore.getState().renameTab("t1", "Fix the build");
		const t1 = useWorkspaceStore
			.getState()
			.workspaces[0].tabs.find((t) => t.id === "t1");
		expect(t1?.name).toBe("Fix the build");
		expect(tabUpdates).toContainEqual(["t1", { name: "Fix the build" }]);
	});
});

describe("releasing across Workspaces and Windows (ADR-0055)", () => {
	it("tells every Window the pane closed", async () => {
		await closePaneNow("a");
		expect(closedPanes).toEqual(["a"]);
	});

	it("never writes a Workspace this Window does not have open", async () => {
		// This Window's copy may be stale; another Window owns that layout.
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
		await releaseOwner("a");
		const layoutWrites = tabUpdates.filter(
			([, u]) => (u as { layoutJson?: string }).layoutJson !== undefined,
		);
		expect(layoutWrites).toEqual([]);
	});
});

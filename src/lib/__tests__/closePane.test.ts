import { beforeEach, describe, expect, it, vi } from "vitest";

const tabUpdates: [string, unknown][] = [];
vi.mock("../ipc", () => ({
	tabs: {
		update: async (id: string, u: unknown) => {
			tabUpdates.push([id, u]);
		},
	},
}));
vi.mock("../terminalManager", () => ({ teardownTerminal: () => {} }));

import { useWorkspaceStore } from "../../stores/workspaceStore";
import { closePaneNow } from "../closePane";
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
						spawnedByPane: "a",
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

describe("closePaneNow and Spawned tabs", () => {
	it("makes the closed pane's Spawned tabs ordinary Tabs", async () => {
		await closePaneNow("a");
		const t2 = useWorkspaceStore
			.getState()
			.workspaces[0].tabs.find((t) => t.id === "t2");
		expect(t2?.spawnedByPane).toBeNull();
		expect(tabUpdates).toContainEqual(["t2", { spawnedByPane: null }]);
	});

	it("leaves them owned when another pane closes", async () => {
		await closePaneNow("c");
		const t2 = useWorkspaceStore
			.getState()
			.workspaces[0].tabs.find((t) => t.id === "t2");
		expect(t2?.spawnedByPane).toBe("a");
	});
});

describe("renameTab", () => {
	it("marks a rename by the user as user-named", async () => {
		await useWorkspaceStore
			.getState()
			.renameTab("t1", "Mine", { byUser: true });
		const t1 = useWorkspaceStore
			.getState()
			.workspaces[0].tabs.find((t) => t.id === "t1");
		expect(t1).toMatchObject({ name: "Mine", userNamed: true });
		expect(tabUpdates).toContainEqual([
			"t1",
			{ name: "Mine", userNamed: true },
		]);
	});

	it("does not mark the app's own renames", async () => {
		await useWorkspaceStore.getState().renameTab("t1", "Fix the build");
		const t1 = useWorkspaceStore
			.getState()
			.workspaces[0].tabs.find((t) => t.id === "t1");
		expect(t1?.userNamed).toBeUndefined();
		expect(tabUpdates).toContainEqual(["t1", { name: "Fix the build" }]);
	});
});

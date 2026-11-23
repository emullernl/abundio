import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));

import type { Tab, WorkspaceWithTabs } from "../../lib/types";
import { mergeRemoteTabs } from "../workspaceStore";

const layout = (pane: string) =>
	JSON.stringify({ type: "terminal", id: pane, ptyId: "" });

function tab(
	id: string,
	name: string,
	position: number,
	pane = `p-${id}`,
): Tab {
	return {
		id,
		workspaceId: "w",
		name,
		layoutJson: layout(pane),
		position,
		createdAt: 0,
		updatedAt: 0,
	} as Tab;
}

function state(tabs: Tab[], active: string) {
	return {
		workspaces: [{ id: "w", tabs } as unknown as WorkspaceWithTabs],
		activeTabByWorkspace: { w: active },
		activeWorkspaceId: "w",
		focusedPaneId: `p-${active}`,
		focusedPaneByTab: {},
	};
}

describe("another Window's Tab change", () => {
	it("takes names, order and new Tabs, and keeps this Window's layouts", () => {
		const mine = tab("a", "One", 0, "mine");
		const merged = mergeRemoteTabs(state([mine], "a"), {
			workspaceId: "w",
			tabs: [
				tab("b", "New", 0),
				{ ...tab("a", "Renamed", 1), layoutJson: "{}" },
			],
		});
		const tabs = merged?.workspaces[0].tabs ?? [];
		expect(tabs.map((t) => [t.id, t.name])).toEqual([
			["b", "New"],
			["a", "Renamed"],
		]);
		expect(tabs[1].layoutJson).toBe(layout("mine"));
		expect(tabs[0].layoutJson).toBe(layout("p-b"));
		expect(merged?.removedTabIds).toEqual([]);
		expect(merged?.activeTabByWorkspace.w).toBe("a");
	});

	it("moves off a Tab that another Window closed", () => {
		const merged = mergeRemoteTabs(
			state([tab("a", "One", 0), tab("b", "Two", 1)], "b"),
			{ workspaceId: "w", tabs: [tab("a", "One", 0)] },
		);
		expect(merged?.removedTabIds).toEqual(["b"]);
		expect(merged?.activeTabByWorkspace.w).toBe("a");
		expect(merged?.focusedPaneId).toBe("p-a");
	});

	it("ignores a Workspace this Window does not have", () => {
		expect(
			mergeRemoteTabs(state([tab("a", "One", 0)], "a"), {
				workspaceId: "other",
				tabs: [tab("x", "X", 0)],
			}),
		).toBeNull();
	});
});

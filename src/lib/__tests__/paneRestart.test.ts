import { describe, expect, it } from "vitest";
import { pickLivePanes } from "../paneRestart";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../types";

const terminal = (id: string, extra: Record<string, unknown> = {}): PaneNode =>
	({ type: "terminal", id, ptyId: "", ...extra }) as PaneNode;

function tab(id: string, layout: PaneNode, name = id): Tab {
	return {
		id,
		workspaceId: "ws-1",
		name,
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function workspace(tabs: Tab[]): WorkspaceWithTabs {
	return {
		id: "ws-1",
		name: "app",
		rootFolder: "/repos/app",
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs,
	};
}

describe("pickLivePanes", () => {
	it("includes a mounted pane and marks it mounted", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		const panes = pickLivePanes(ws, {}, { p1: "pty-1" }, {}, {});
		expect(panes).toHaveLength(1);
		expect(panes[0]).toMatchObject({
			paneId: "p1",
			ptyId: "pty-1",
			tabId: "t1",
			mounted: true,
		});
	});

	// A background workspace's panes are unmounted but their PTYs are alive.
	it("includes a panePtyMap-only pane as unmounted", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		const panes = pickLivePanes(ws, { p1: "pty-9" }, {}, {}, {});
		expect(panes[0]).toMatchObject({ ptyId: "pty-9", mounted: false });
	});

	// The mounted instance is authoritative; panePtyMap can lag behind.
	it("prefers the mounted instance's ptyId over panePtyMap", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		const panes = pickLivePanes(ws, { p1: "stale" }, { p1: "fresh" }, {}, {});
		expect(panes[0].ptyId).toBe("fresh");
	});

	// The layout's own ptyId is written back lazily and goes stale — trusting it
	// would kill the wrong process.
	it("ignores a ptyId stored on the layout node", () => {
		const ws = workspace([
			tab("t1", terminal("p1", { ptyId: "layout-stale" })),
		]);
		expect(pickLivePanes(ws, {}, {}, {}, {})).toEqual([]);
	});

	it("excludes panes with no live PTY", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		expect(pickLivePanes(ws, {}, {}, {}, {})).toEqual([]);
	});

	it("walks splits and covers every tab", () => {
		const split: PaneNode = {
			type: "split",
			id: "s1",
			direction: "horizontal",
			ratio: 0.5,
			first: terminal("p1"),
			second: terminal("p2"),
		} as PaneNode;
		const ws = workspace([tab("t1", split), tab("t2", terminal("p3"))]);
		const panes = pickLivePanes(ws, {}, { p1: "a", p2: "b", p3: "c" }, {}, {});
		expect(panes.map((p) => p.paneId)).toEqual(["p1", "p2", "p3"]);
		expect(panes.map((p) => p.tabId)).toEqual(["t1", "t1", "t2"]);
	});

	it("skips non-terminal nodes", () => {
		const split: PaneNode = {
			type: "split",
			id: "s1",
			direction: "vertical",
			ratio: 0.5,
			first: terminal("p1"),
			second: { type: "file", id: "f1", filePath: "/x.ts" },
		} as PaneNode;
		const ws = workspace([tab("t1", split)]);
		const panes = pickLivePanes(ws, {}, { p1: "a", f1: "b" }, {}, {});
		expect(panes.map((p) => p.paneId)).toEqual(["p1"]);
	});

	it("carries agentId, state, title and cwd", () => {
		const ws = workspace([
			tab("t1", terminal("p1", { agentId: "claude", cwd: "/custom" }), "Tab A"),
		]);
		const panes = pickLivePanes(
			ws,
			{},
			{ p1: "pty-1" },
			{ "pty-1": { state: "active" } as never },
			{ p1: "claude — building" },
		);
		expect(panes[0]).toMatchObject({
			agentId: "claude",
			state: "active",
			title: "claude — building",
			cwd: "/custom",
			tabName: "Tab A",
		});
	});

	it("falls back to the workspace root when a pane has no cwd", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		const panes = pickLivePanes(ws, {}, { p1: "pty-1" }, {}, {});
		expect(panes[0].cwd).toBe("/repos/app");
	});

	it("defaults an unknown activity to idle", () => {
		const ws = workspace([tab("t1", terminal("p1"))]);
		const panes = pickLivePanes(ws, {}, { p1: "pty-1" }, {}, {});
		expect(panes[0].state).toBe("idle");
	});

	it("tolerates a malformed layout without dropping other tabs", () => {
		const broken: Tab = { ...tab("t1", terminal("p1")), layoutJson: "{oops" };
		const ws = workspace([broken, tab("t2", terminal("p2"))]);
		const panes = pickLivePanes(ws, {}, { p1: "a", p2: "b" }, {}, {});
		expect(panes.map((p) => p.paneId)).toEqual(["p2"]);
	});

	it("returns nothing for a workspace with no tabs", () => {
		expect(pickLivePanes(workspace([]), {}, {}, {}, {})).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import {
	countAgentPanesByFolder,
	isAloneInFolder,
	launchFolder,
} from "../sessionResume";
import type { PaneNode, WorkspaceWithTabs } from "../types";

const ws = (id: string, rootFolder: string, layouts: PaneNode[]) =>
	({
		id,
		rootFolder,
		tabs: layouts.map((l, i) => ({
			id: `${id}-t${i}`,
			layoutJson: JSON.stringify(l),
		})),
	}) as unknown as WorkspaceWithTabs;
const pane = (id: string, agentId?: string, cwd?: string): PaneNode => ({
	type: "terminal",
	id,
	ptyId: "",
	...(agentId ? { agentId } : {}),
	...(cwd ? { cwd } : {}),
});

describe("countAgentPanesByFolder", () => {
	it("counts panes per Agent and launch folder across Workspaces and Tabs", () => {
		const counts = countAgentPanesByFolder([
			ws("a", "/repo", [pane("1", "claude"), pane("2", "claude")]),
			ws("b", "/repo", [pane("3", "codex"), pane("4")]),
			ws("c", "/other", [pane("5", "claude")]),
		]);
		expect(isAloneInFolder(counts, "claude", "/repo")).toBe(false);
		expect(isAloneInFolder(counts, "codex", "/repo")).toBe(true);
		expect(isAloneInFolder(counts, "claude", "/other")).toBe(true);
	});

	it("uses a pane's own folder before its Workspace's", () => {
		const counts = countAgentPanesByFolder([
			ws("a", "/repo", [pane("1", "claude"), pane("2", "claude", "/repo/sub")]),
		]);
		expect(isAloneInFolder(counts, "claude", "/repo")).toBe(true);
		expect(isAloneInFolder(counts, "claude", "/repo/sub")).toBe(true);
	});

	it("skips tabs whose layout does not parse", () => {
		const broken = {
			id: "x",
			rootFolder: "/r",
			tabs: [{ id: "t", layoutJson: "not json" }],
		} as unknown as WorkspaceWithTabs;
		expect(countAgentPanesByFolder([broken]).size).toBe(0);
	});
});

describe("launchFolder", () => {
	it("falls back to the Workspace folder", () => {
		expect(
			launchFolder({ type: "terminal", id: "p", ptyId: "" }, "/root"),
		).toBe("/root");
		expect(
			launchFolder({ type: "terminal", id: "p", ptyId: "", cwd: "/x" }, "/r"),
		).toBe("/x");
	});
});

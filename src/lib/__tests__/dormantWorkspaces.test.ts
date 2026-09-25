import { describe, expect, it } from "vitest";
import {
	agentCounts,
	buildRelaunchRows,
	dormantWorkspaces,
	isDormant,
	rememberedAgents,
} from "../dormantWorkspaces";
import type { WorkspaceWithTabs } from "../types";
import type { WorktreeGroupFacts } from "../worktreeGrouping";

function term(id: string, agentId?: string) {
	return { type: "terminal", id, ptyId: "", ...(agentId ? { agentId } : {}) };
}

function ws(
	id: string,
	tabs: unknown[] = [term(`${id}-p`, "claude")],
	position = 0,
): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		position,
		tabs: tabs.map((layout, i) => ({
			id: `${id}-t${i}`,
			workspaceId: id,
			name: "Tab",
			layoutJson: JSON.stringify(layout),
			position: i,
			createdAt: 0,
			updatedAt: 0,
		})),
	} as unknown as WorkspaceWithTabs;
}

const known = new Set(["claude", "codex"]);
const none = new Set<string>();

// See the Dormant workspace and Relaunch entries in CONTEXT.md.
describe("dormant workspaces", () => {
	it("collects remembered Agents across Tabs and splits", () => {
		const w = ws("a", [
			term("p1", "claude"),
			{
				type: "split",
				id: "s",
				direction: "vertical",
				ratio: 0.5,
				first: term("p2", "codex"),
				second: term("p3"),
			},
		]);
		expect(rememberedAgents(w)).toEqual([
			{ paneId: "p1", agentId: "claude" },
			{ paneId: "p2", agentId: "codex" },
		]);
	});

	it("is Dormant only when closed here and remembering a known Agent", () => {
		expect(isDormant(ws("a"), none, known)).toBe(true);
		expect(isDormant(ws("a"), new Set(["a"]), known)).toBe(false);
		expect(isDormant(ws("a", [term("p")]), none, known)).toBe(false);
		// An Agent since removed would come back as a plain shell.
		expect(isDormant(ws("a", [term("p", "gone")]), none, known)).toBe(false);
	});

	it("filters a list down to the Dormant ones", () => {
		const list = [ws("a"), ws("b", [term("p")]), ws("c")];
		expect(
			dormantWorkspaces(list, new Set(["c"]), known).map((w) => w.id),
		).toEqual(["a"]);
	});

	it("counts Agents in first-seen order", () => {
		expect(agentCounts(["claude", "codex", "claude"])).toEqual([
			{ agentId: "claude", count: 2 },
			{ agentId: "codex", count: 1 },
		]);
	});
});

describe("buildRelaunchRows", () => {
	const primary = ws("repo", undefined, 0);
	const linkedA = ws("repo-a", undefined, 1);
	const linkedB = ws("repo-b", [term("p")], 2); // remembers no Agent
	const solo = ws("solo", undefined, 3);
	const facts: Record<string, WorktreeGroupFacts> = {
		repo: { worktreeGroupKey: "g", isMainWorktree: true },
		"repo-a": { worktreeGroupKey: "g", isMainWorktree: false },
		"repo-b": { worktreeGroupKey: "g", isMainWorktree: false },
	};
	const all = [primary, linkedA, linkedB, solo];
	const shape = (rows: ReturnType<typeof buildRelaunchRows>) =>
		rows.map((r) =>
			r.kind === "heading"
				? `# ${r.workspace.id}`
				: `${r.indent ? "  " : ""}${r.workspace.id}`,
		);

	it("indents Dormant Linked worktrees under a Dormant Primary", () => {
		expect(shape(buildRelaunchRows(all, facts, none, known))).toEqual([
			"repo",
			"  repo-a",
			"solo",
		]);
	});

	it("shows an Opened Primary as a heading", () => {
		expect(
			shape(buildRelaunchRows(all, facts, new Set(["repo"]), known)),
		).toEqual(["# repo", "  repo-a", "solo"]);
	});

	it("leaves out a set with nothing Dormant", () => {
		expect(
			shape(buildRelaunchRows(all, facts, new Set(["repo", "repo-a"]), known)),
		).toEqual(["solo"]);
	});

	it("carries the Agent counts on each row", () => {
		const rows = buildRelaunchRows(
			[ws("x", [term("p1", "claude"), term("p2", "claude")])],
			{},
			none,
			known,
		);
		expect(rows[0]).toMatchObject({
			kind: "workspace",
			agents: [{ agentId: "claude", count: 2 }],
		});
	});
});

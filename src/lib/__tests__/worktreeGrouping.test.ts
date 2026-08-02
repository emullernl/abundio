import { describe, expect, it } from "vitest";
import type { WorkspaceWithTabs } from "../types";
import {
	buildWorkspaceRows,
	distinctGroupKeys,
	flattenRowsToIds,
	inheritSourceWorkspaceId,
	rowId,
	type WorktreeGroupFacts,
} from "../worktreeGrouping";

function ws(id: string, position: number): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/repos/${id}`,
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		lastBranch: null,
		position,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [],
	};
}

const KEY = "/repos/app/.git";

describe("buildWorkspaceRows", () => {
	it("renders non-grouped workspaces as standalone rows", () => {
		const list = [ws("a", 0), ws("b", 1)];
		const facts: Record<string, WorktreeGroupFacts> = {
			a: { worktreeGroupKey: null, isMainWorktree: false },
			b: { worktreeGroupKey: "/repos/b/.git", isMainWorktree: true },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows.every((r) => r.kind === "standalone")).toBe(true);
	});

	it("does not group a single-worktree repo (no set chrome)", () => {
		const list = [ws("a", 0)];
		const facts = { a: { worktreeGroupKey: KEY, isMainWorktree: true } };
		const rows = buildWorkspaceRows(list, facts);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("standalone");
	});

	it("groups ≥2 worktrees with primary first, linked by position", () => {
		// Input order deliberately puts a linked worktree before the primary.
		const list = [ws("linkedB", 0), ws("primary", 1), ws("linkedA", 2)];
		const facts: Record<string, WorktreeGroupFacts> = {
			primary: { worktreeGroupKey: KEY, isMainWorktree: true },
			linkedA: { worktreeGroupKey: KEY, isMainWorktree: false },
			linkedB: { worktreeGroupKey: KEY, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.kind).toBe("set");
		if (row.kind !== "set") return;
		expect(row.primary.id).toBe("primary");
		// linked ordered by position: linkedB(0) before linkedA(2)
		expect(row.linked.map((w) => w.id)).toEqual(["linkedB", "linkedA"]);
	});

	it("falls back to flat when a set has no primary (primary entry removed)", () => {
		const list = [ws("linkedA", 0), ws("linkedB", 1)];
		const facts: Record<string, WorktreeGroupFacts> = {
			linkedA: { worktreeGroupKey: KEY, isMainWorktree: false },
			linkedB: { worktreeGroupKey: KEY, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.kind === "standalone")).toBe(true);
	});

	it("orders a set block among standalones by the primary's position", () => {
		const list = [
			ws("alpha", 0),
			ws("linked", 1),
			ws("primary", 2),
			ws("zeta", 3),
		];
		const facts: Record<string, WorktreeGroupFacts> = {
			alpha: { worktreeGroupKey: null, isMainWorktree: false },
			primary: { worktreeGroupKey: KEY, isMainWorktree: true },
			linked: { worktreeGroupKey: KEY, isMainWorktree: false },
			zeta: { worktreeGroupKey: null, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		// alpha(0), set@primary(2), zeta(3)
		expect(rows.map(rowId)).toEqual(["ws:alpha", `set:${KEY}`, "ws:zeta"]);
	});

	it("preserves input order for rows sharing an identical position", () => {
		// Two standalone workspaces both at position 0 (DB race / glitch) must
		// keep their input order — relies on a stable sort.
		const list = [ws("first", 0), ws("second", 0)];
		const facts: Record<string, WorktreeGroupFacts> = {
			first: { worktreeGroupKey: null, isMainWorktree: false },
			second: { worktreeGroupKey: null, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows.map(rowId)).toEqual(["ws:first", "ws:second"]);
	});

	it("treats a workspace missing from facts as standalone (mid-sync race)", () => {
		// `syncWorktreeFacts` hasn't returned yet for a just-added workspace.
		const list = [ws("known", 0), ws("pending", 1)];
		const facts: Record<string, WorktreeGroupFacts> = {
			known: { worktreeGroupKey: KEY, isMainWorktree: true },
			// `pending` intentionally absent from facts.
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.kind === "standalone")).toBe(true);
	});

	it("keeps two distinct repos as separate sets", () => {
		const k1 = "/repos/one/.git";
		const k2 = "/repos/two/.git";
		const list = [ws("p1", 0), ws("l1", 1), ws("p2", 2), ws("l2", 3)];
		const facts: Record<string, WorktreeGroupFacts> = {
			p1: { worktreeGroupKey: k1, isMainWorktree: true },
			l1: { worktreeGroupKey: k1, isMainWorktree: false },
			p2: { worktreeGroupKey: k2, isMainWorktree: true },
			l2: { worktreeGroupKey: k2, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(rows.map(rowId)).toEqual([`set:${k1}`, `set:${k2}`]);
	});
});

describe("flattenRowsToIds", () => {
	it("flattens sets as primary-then-linked, preserving block order", () => {
		const list = [ws("primary", 0), ws("linked", 1), ws("solo", 2)];
		const facts: Record<string, WorktreeGroupFacts> = {
			primary: { worktreeGroupKey: KEY, isMainWorktree: true },
			linked: { worktreeGroupKey: KEY, isMainWorktree: false },
			solo: { worktreeGroupKey: null, isMainWorktree: false },
		};
		const rows = buildWorkspaceRows(list, facts);
		expect(flattenRowsToIds(rows)).toEqual(["primary", "linked", "solo"]);
	});
});

describe("distinctGroupKeys", () => {
	it("returns each repo key once, skipping non-git workspaces", () => {
		const list = [ws("a", 0), ws("b", 1), ws("c", 2)];
		const facts: Record<string, WorktreeGroupFacts> = {
			a: { worktreeGroupKey: KEY, isMainWorktree: true },
			b: { worktreeGroupKey: KEY, isMainWorktree: false },
			c: { worktreeGroupKey: null, isMainWorktree: false },
		};
		expect(distinctGroupKeys(list, facts)).toEqual([KEY]);
	});
});

describe("inheritSourceWorkspaceId", () => {
	const facts = (
		entries: [string, string | null, boolean][],
	): Record<string, WorktreeGroupFacts> =>
		Object.fromEntries(
			entries.map(([id, key, isMain]) => [
				id,
				{ worktreeGroupKey: key, isMainWorktree: isMain },
			]),
		);

	it("resolves a linked worktree to its set's main worktree", () => {
		const list = [ws("main", 0), ws("feat", 1)];
		const f = facts([
			["main", KEY, true],
			["feat", KEY, false],
		]);
		expect(inheritSourceWorkspaceId(list, f, "feat")).toBe("main");
	});

	it("returns null for the main worktree itself", () => {
		const list = [ws("main", 0), ws("feat", 1)];
		const f = facts([
			["main", KEY, true],
			["feat", KEY, false],
		]);
		expect(inheritSourceWorkspaceId(list, f, "main")).toBeNull();
	});

	it("returns null for a standalone workspace", () => {
		const list = [ws("solo", 0)];
		expect(
			inheritSourceWorkspaceId(list, facts([["solo", null, false]]), "solo"),
		).toBeNull();
	});

	// Matches buildWorkspaceRows: a group with no primary renders as standalone
	// rows, so there is nothing to inherit from.
	it("returns null for a primary-less group", () => {
		const list = [ws("a", 0), ws("b", 1)];
		const f = facts([
			["a", KEY, false],
			["b", KEY, false],
		]);
		expect(inheritSourceWorkspaceId(list, f, "a")).toBeNull();
	});

	it("does not cross group boundaries", () => {
		const list = [ws("main-a", 0), ws("feat-b", 1)];
		const f = facts([
			["main-a", KEY, true],
			["feat-b", "/repos/other/.git", false],
		]);
		expect(inheritSourceWorkspaceId(list, f, "feat-b")).toBeNull();
	});

	it("returns null when the workspace has no facts yet", () => {
		expect(inheritSourceWorkspaceId([ws("x", 0)], {}, "x")).toBeNull();
	});
});

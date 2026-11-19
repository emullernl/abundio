import { describe, expect, it, vi } from "vitest";
import {
	applyLayoutOps,
	diffLayout,
	type LayoutOp,
	sameLayout,
} from "../layoutOps";
import {
	clearSpawnedBy,
	collectPaneIds,
	collectTerminalIds,
	extractNode,
	findNode,
	insertBesideNode,
	markSpawned,
	pruneOrphanDerived,
	removeNode,
	replaceNode,
	setAgentHandle,
	setAgentId,
	setAgentSessionId,
	setCwd,
	setFileNodeView,
	wrapInSplit,
} from "../paneTree";
import type { PaneNode } from "../types";
import fixture from "./fixtures/layoutOps.json";

/**
 * Random layouts edited with the real `paneTree.ts` functions, one to three
 * edits at a time, then diffed into ops. Every case is in
 * `fixtures/layoutOps.json`, which `layout_ops.rs` replays: applying the ops
 * to `base` must give `next` in Rust too.
 *
 * Regenerate after a change:
 * `UPDATE_LAYOUT_OPS=1 npx vitest run src/lib/__tests__/layoutOps.test.ts`
 */

const CASES = 300;
const NODE_FS = "node:fs";

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)];
}

let nextId = 0;
const id = (p: string) => `${p}${++nextId}`;

function leaf(rand: () => number, fileIds: string[]): PaneNode {
	const kind = pick(rand, ["terminal", "terminal", "file", "derived"]);
	if (kind === "file" || (kind === "derived" && fileIds.length === 0)) {
		const n: PaneNode = {
			type: "file",
			id: id("f"),
			filePath: `/w/${id("doc")}.md`,
		};
		fileIds.push(n.id);
		return n;
	}
	if (kind === "derived") {
		return rand() < 0.5
			? { type: "preview", id: id("v"), sourcePaneId: pick(rand, fileIds) }
			: {
					type: "mergeSide",
					id: id("m"),
					sourcePaneId: pick(rand, fileIds),
					side: pick(rand, ["current", "incoming", "base"] as const),
				};
	}
	const t: PaneNode = { type: "terminal", id: id("t"), ptyId: "" };
	if (rand() < 0.4) t.agentId = pick(rand, ["claude", "codex"]);
	if (t.agentId && rand() < 0.5) t.agentSessionId = id("sess");
	if (rand() < 0.3) t.cwd = "/w/sub";
	if (rand() < 0.3) t.agentHandle = id("Agent ");
	return t;
}

function tree(rand: () => number, depth: number, fileIds: string[]): PaneNode {
	if (depth === 0 || rand() < 0.35) return leaf(rand, fileIds);
	return {
		type: "split",
		id: id("s"),
		direction: pick(rand, ["horizontal", "vertical"] as const),
		ratio: pick(rand, [0.5, 0.3, 0.7]),
		first: tree(rand, depth - 1, fileIds),
		second: tree(rand, depth - 1, fileIds),
	};
}

function edit(rand: () => number, t: PaneNode): PaneNode {
	const panes = collectPaneIds(t);
	const terms = collectTerminalIds(t);
	const any = pick(rand, panes);
	const term = terms.length ? pick(rand, terms) : any;
	switch (
		pick(rand, [
			"split",
			"remove",
			"beside",
			"move",
			"agent",
			"session",
			"spawned",
			"handle",
			"clearSpawned",
			"cwd",
			"view",
			"ratio",
			"prune",
			"replaceLeaf",
			"ptyId",
		] as const)
	) {
		case "split":
			return wrapInSplit(
				t,
				any,
				{ type: "terminal", id: id("t"), ptyId: "" },
				pick(rand, ["horizontal", "vertical"] as const),
			);
		case "remove":
			return removeNode(t, any) ?? t;
		case "beside":
			return insertBesideNode(
				t,
				any,
				{ type: "terminal", id: id("t"), ptyId: "" },
				pick(rand, ["top", "right", "bottom", "left"] as const),
			);
		case "move": {
			const target = pick(rand, panes);
			if (target === any) return t;
			const { remaining, removed } = extractNode(t, any);
			if (!remaining || !removed || !findNode(remaining, target)) return t;
			return insertBesideNode(
				remaining,
				target,
				removed,
				pick(rand, ["top", "right", "bottom", "left"] as const),
			);
		}
		case "agent":
			return setAgentId(
				t,
				term,
				pick(rand, ["claude", "codex", undefined] as const),
			);
		case "session":
			return setAgentSessionId(t, term, "claude", id("sess"));
		case "spawned":
			return markSpawned(
				t,
				term,
				pick(rand, panes),
				rand() < 0.5 ? id("Helper ") : undefined,
			);
		case "handle":
			return setAgentHandle(t, term, rand() < 0.3 ? undefined : id("Agent "));
		case "clearSpawned": {
			const owner = pick(rand, panes);
			const marked = markSpawned(t, term, owner);
			return clearSpawnedBy(marked, owner);
		}
		case "cwd":
			return setCwd(t, term, rand() < 0.3 ? undefined : `/w/${id("d")}`);
		case "view":
			return setFileNodeView(
				t,
				any,
				pick(rand, ["rendered", "source"] as const),
			);
		case "ratio": {
			if (t.type !== "split") return t;
			return replaceNode(t, t.id, { ...t, ratio: pick(rand, [0.2, 0.61]) });
		}
		case "prune":
			return pruneOrphanDerived(removeNode(t, any) ?? t) ?? t;
		case "replaceLeaf":
			return replaceNode(t, any, {
				type: "file",
				id: id("f"),
				filePath: "/w/other.ts",
				isDiff: rand() < 0.5,
			});
		case "ptyId": {
			const n = findNode(t, term);
			if (n?.type !== "terminal") return t;
			return replaceNode(t, term, { ...n, ptyId: id("pty") });
		}
	}
}

interface Case {
	base: PaneNode;
	next: PaneNode;
	ops: LayoutOp[];
}

function json<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

function generate(): Case[] {
	nextId = 0;
	const uuid = vi
		.spyOn(crypto, "randomUUID")
		.mockImplementation(
			() => `00000000-0000-0000-0000-${String(++nextId).padStart(12, "0")}`,
		);
	const cases: Case[] = [];
	for (let c = 0; c < CASES; c++) {
		const rand = prng(9100 + c);
		const base = json(tree(rand, 3, []));
		let next = base;
		const edits = 1 + Math.floor(rand() * 3);
		for (let e = 0; e < edits; e++) next = edit(rand, next);
		next = json(next);
		cases.push({ base, next, ops: diffLayout(base, next) });
	}
	uuid.mockRestore();
	return cases;
}

describe("layout ops", () => {
	const cases = generate();

	it("turn every edit into ops that rebuild it", () => {
		for (const c of cases) {
			expect(applyLayoutOps(c.base, c.ops)).toEqual(c.next);
		}
	});

	it("cover every kind of op", () => {
		const kinds = new Set(cases.flatMap((c) => c.ops.map((o) => o.op)));
		expect(kinds).toEqual(new Set(["set", "replace", "patch"]));
		expect(cases.some((c) => c.ops.length === 0)).toBe(true);
	});

	it("never replace more than the edit touched", () => {
		// Stamping a field on a pane is a patch of that pane alone.
		const t: PaneNode = {
			type: "split",
			id: "s",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", id: "a", ptyId: "" },
			second: { type: "terminal", id: "b", ptyId: "" },
		};
		expect(
			diffLayout(
				t,
				json(
					setAgentSessionId(setAgentId(t, "b", "claude"), "b", "claude", "x"),
				),
			),
		).toEqual([
			{
				op: "patch",
				id: "b",
				set: { agentId: "claude", agentSessionId: "x" },
				unset: [],
			},
		]);
		expect(
			diffLayout(t, json(setCwd(setCwd(t, "a", "/x"), "a", undefined))),
		).toEqual([]);
	});

	it("refuse ops on a node that is gone", () => {
		const t: PaneNode = { type: "terminal", id: "a", ptyId: "" };
		expect(
			applyLayoutOps(t, [
				{ op: "patch", id: "zz", set: { cwd: "/" }, unset: [] },
			]),
		).toBeNull();
	});

	it("compare layouts whatever their key order", () => {
		expect(
			sameLayout(
				{ type: "terminal", id: "a", ptyId: "" },
				JSON.parse('{"ptyId":"","id":"a","type":"terminal"}'),
			),
		).toBe(true);
	});

	it("match the fixture Rust replays", async () => {
		const proc = (
			globalThis as {
				process?: { env?: Record<string, string>; cwd(): string };
			}
		).process;
		if (proc?.env?.UPDATE_LAYOUT_OPS) {
			const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
				writeFileSync(path: string, data: string): void;
			};
			fs.writeFileSync(
				`${proc.cwd()}/src/lib/__tests__/fixtures/layoutOps.json`,
				`${JSON.stringify({ _comment: "Generated by layoutOps.test.ts; replayed by layout_ops.rs.", cases })}\n`,
			);
			return;
		}
		expect(cases).toEqual((fixture as unknown as { cases: Case[] }).cases);
	});
});

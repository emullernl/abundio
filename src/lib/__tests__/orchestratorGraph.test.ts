import { describe, expect, it } from "vitest";
import {
	AGENT_W,
	type GraphAgent,
	graphModel,
	layoutGraph,
	nestBySpawner,
	polylinePath,
	routeBetween,
} from "../orchestratorGraph";
import type { PaneNode, WorkspaceWithTabs } from "../types";

const term = (id: string, extra: Record<string, unknown> = {}): PaneNode =>
	({ type: "terminal", id, ptyId: "", ...extra }) as PaneNode;
const split = (a: PaneNode, b: PaneNode): PaneNode => ({
	type: "split",
	id: `s-${a.id}`,
	direction: "vertical",
	ratio: 0.5,
	first: a,
	second: b,
});

function ws(
	id: string,
	layout: PaneNode,
	kind: "work" | "orchestrator" = "work",
): WorkspaceWithTabs {
	return {
		id,
		name: id.toUpperCase(),
		kind,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab 1",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

const agent = (paneId: string, depth = 0): GraphAgent => ({
	paneId,
	workspaceId: "w",
	tabId: "t",
	tabName: "T",
	agentId: undefined,
	handle: undefined,
	spawnedBy: undefined,
	depth,
});

describe("graphModel", () => {
	const agentPtys = new Set(["x1", "x3", "xb", "xo", "xh"]);
	const input = {
		panePtyMap: {
			a1: "x1",
			a2: "x2",
			a3: "x3",
			b1: "xb",
			o1: "xo",
			h1: "xh",
		} as Record<string, string>,
		isAgentPty: (p: string) => agentPtys.has(p),
		orchestratorPaneId: "o1",
	};

	it("draws Opened Workspaces only, in sidebar order, live Agents only", () => {
		const a = ws("a", split(term("a1"), split(term("a2"), term("a3"))));
		const b = ws("b", term("b1"));
		const c = ws("c", term("c1", { agentId: "codex" }));
		const model = graphModel({
			...input,
			workspaces: [a, b, c],
			order: ["b", "a", "c"],
			openedWorkspaceIds: new Set(["a", "b"]),
		});
		expect(model.workspaces.map((p) => p.id)).toEqual(["b", "a"]);
		expect(model.workspaces[1].agents.map((x) => x.paneId)).toEqual([
			"a1",
			"a3",
		]);
	});

	it("puts the Orchestrator's own helpers on their own, without itself", () => {
		const o = ws("o", split(term("o1"), term("h1")), "orchestrator");
		const model = graphModel({
			...input,
			workspaces: [o],
			order: [],
			openedWorkspaceIds: new Set(["o"]),
		});
		expect(model.workspaces).toEqual([]);
		expect(model.helpers.map((h) => h.paneId)).toEqual(["h1"]);
	});

	it("rings every Agent round its Workspace, a helper next to its spawner", () => {
		const layout = split(
			term("lead"),
			split(term("other"), term("fred", { spawnedBy: "lead" })),
		);
		const model = graphModel({
			...input,
			panePtyMap: { lead: "x1", other: "x3", fred: "xb" },
			workspaces: [ws("w", layout)],
			order: [],
			openedWorkspaceIds: new Set(["w"]),
		});
		const agents = model.workspaces[0].agents;
		expect(agents.map((a) => a.paneId)).toEqual(["lead", "fred", "other"]);
		expect(agents.every((a) => a.depth === 0 && !a.spawnedBy)).toBe(true);
	});

	it("leaves out an Opened Workspace with no Agent running", () => {
		const model = graphModel({
			...input,
			workspaces: [ws("d", term("d1"))],
			order: [],
			openedWorkspaceIds: new Set(["d"]),
		});
		expect(model.workspaces).toEqual([]);
	});
});

describe("nestBySpawner", () => {
	const ag = (paneId: string, spawnedBy?: string): GraphAgent => ({
		...agent(paneId),
		spawnedBy,
	});

	it("puts helpers under their spawner, depth-first", () => {
		const out = nestBySpawner([
			ag("h2", "lead"),
			ag("lead"),
			ag("other"),
			ag("h1", "lead"),
			ag("g", "h1"),
		]);
		expect(out.map((a) => [a.paneId, a.depth])).toEqual([
			["lead", 0],
			["h2", 1],
			["h1", 1],
			["g", 2],
			["other", 0],
		]);
	});

	it("keeps the members of a spawn cycle", () => {
		const out = nestBySpawner([ag("a", "b"), ag("b", "a")]);
		expect(out.map((a) => a.paneId).sort()).toEqual(["a", "b"]);
	});
});

describe("layoutGraph", () => {
	const cluster = (id: string, agents: GraphAgent[]) => ({
		id,
		name: id,
		agents,
	});
	type Box = { x: number; y: number; width: number; height: number };
	const overlap = (a: Box, b: Box) =>
		Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
		Math.abs(a.y - b.y) < (a.height + b.height) / 2;
	const inside = (inner: Box, outer: Box) =>
		inner.x - inner.width / 2 >= outer.x - outer.width / 2 &&
		inner.x + inner.width / 2 <= outer.x + outer.width / 2 &&
		inner.y - inner.height / 2 >= outer.y - outer.height / 2 &&
		inner.y + inner.height / 2 <= outer.y + outer.height / 2;

	const two = layoutGraph({
		workspaces: [
			cluster("a", [agent("a1"), agent("a2"), agent("a3")]),
			cluster("b", [agent("b1")]),
		],
		helpers: [],
	});

	it("puts the Orchestrator on the left, the containers right of the trunk", () => {
		const o = two.orchestrator;
		expect(o.x + o.width / 2).toBeLessThan(two.trunkX);
		for (const c of Object.values(two.containers)) {
			expect(c.x - c.width / 2).toBeGreaterThan(two.trunkX);
		}
		// Left-aligned and stacked in order.
		const { a, b } = two.containers;
		expect(a.x - a.width / 2).toBe(b.x - b.width / 2);
		expect(b.y).toBeGreaterThan(a.y + a.height / 2);
	});

	it("lays each Workspace's Agents in one row inside its container", () => {
		const { a } = two.containers;
		const row = ["a1", "a2", "a3"].map((id) => two.agents[id]);
		expect(new Set(row.map((r) => r.y)).size).toBe(1);
		expect(row[1].x).toBeGreaterThan(row[0].x + AGENT_W);
		expect(row[2].x).toBeGreaterThan(row[1].x + AGENT_W);
		for (const r of row) expect(inside(r, a)).toBe(true);
		// The bus runs above the row.
		expect(a.busY).toBeLessThan(row[0].y - row[0].height / 2);
	});

	it("never wraps a long row", () => {
		const many = Array.from({ length: 12 }, (_, k) => agent(`p${k}`));
		const l = layoutGraph({ workspaces: [cluster("w", many)], helpers: [] });
		expect(new Set(many.map((a) => l.agents[a.paneId].y)).size).toBe(1);
	});

	it("puts Open workspace right below the Orchestrator, its helpers below that", () => {
		const l = layoutGraph({
			workspaces: [cluster("a", [agent("a1")])],
			helpers: [agent("h1"), agent("h2")],
		});
		expect(l.add.x).toBe(l.orchestrator.x);
		expect(l.add.y).toBeGreaterThan(l.orchestrator.y);
		expect(l.add.y - l.orchestrator.y).toBeLessThan(80);
		const hc = l.helperContainer;
		expect(hc).not.toBeNull();
		if (!hc) return;
		expect(hc.y).toBeGreaterThan(l.add.y);
		expect(hc.x + hc.width / 2).toBeLessThan(l.trunkX);
		expect(inside(l.agents.h1, hc)).toBe(true);
	});

	it("never overlaps two nodes or two containers", () => {
		const l = layoutGraph({
			workspaces: Array.from({ length: 8 }, (_, i) =>
				cluster(
					`w${i}`,
					Array.from({ length: (i % 5) + 1 }, (_, k) => agent(`w${i}-${k}`)),
				),
			),
			helpers: [agent("h1")],
		});
		const nodes = [l.orchestrator, l.add, ...Object.values(l.agents)];
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				expect(overlap(nodes[i], nodes[j]), `${i}/${j}`).toBe(false);
			}
		}
		const boxes = [
			...Object.values(l.containers),
			...(l.helperContainer ? [l.helperContainer] : []),
		];
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				expect(overlap(boxes[i], boxes[j]), `c${i}/c${j}`).toBe(false);
			}
		}
	});
});

describe("routeBetween", () => {
	const l = layoutGraph({
		workspaces: [
			{ id: "a", name: "a", agents: [agent("a1"), agent("a2")] },
			{ id: "b", name: "b", agents: [agent("b1")] },
		],
		helpers: [],
	});

	it("goes along the bus between two Agents of one Workspace", () => {
		const r = routeBetween(l, "a1", "a2");
		expect(r).toHaveLength(4);
		expect(r?.[1].y).toBe(l.containers.a.busY);
		expect(r?.[2].y).toBe(l.containers.a.busY);
	});

	it("goes by way of the trunk between two Workspaces", () => {
		const r = routeBetween(l, "a1", "b1") ?? [];
		const xs = r.map((p) => p.x);
		expect(xs).toContain(l.trunkX);
		expect(r[0]).toMatchObject({ x: l.agents.a1.x });
		expect(r[r.length - 1]).toMatchObject({ x: l.agents.b1.x });
		// Only right angles: each step moves along one axis.
		for (let i = 1; i < r.length; i++) {
			expect(r[i].x === r[i - 1].x || r[i].y === r[i - 1].y).toBe(true);
		}
	});

	it("starts at the Orchestrator's right side", () => {
		const r = routeBetween(l, "orchestrator", "b1") ?? [];
		expect(r[0].x).toBe(l.orchestrator.x + l.orchestrator.width / 2);
		expect(r[r.length - 1].x).toBe(l.agents.b1.x);
	});

	it("has no route to an Agent that is not drawn", () => {
		expect(routeBetween(l, "a1", "gone")).toBeNull();
	});

	it("writes an SVG path", () => {
		expect(
			polylinePath([
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
			]),
		).toBe("M 0 0 L 10 0");
	});
});

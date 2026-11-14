import { describe, expect, it } from "vitest";
import {
	AGENT_W,
	type GraphAgent,
	graphModel,
	layoutGraph,
	nestBySpawner,
	streamPath,
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
	const dist = (p: { x: number; y: number }, q = { x: 0, y: 0 }) =>
		Math.hypot(p.x - q.x, p.y - q.y);
	const cluster = (id: string, agents: GraphAgent[]) => ({
		id,
		name: id,
		agents,
	});
	type Box = { x: number; y: number; width: number; height: number };
	const overlap = (a: Box, b: Box) =>
		Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
		Math.abs(a.y - b.y) < (a.height + b.height) / 2;
	const allBoxes = (l: ReturnType<typeof layoutGraph>) => [
		l.orchestrator,
		l.add,
		...Object.values(l.workspaces),
		...Object.values(l.agents),
		...Object.values(l.helpers),
	];
	const noOverlaps = (l: ReturnType<typeof layoutGraph>) => {
		const boxes = allBoxes(l);
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				expect(overlap(boxes[i], boxes[j]), `${i} / ${j}`).toBe(false);
			}
		}
	};

	it("rings the Workspaces round the Orchestrator, their Agents round them", () => {
		const layout = layoutGraph({
			workspaces: [
				cluster("a", [agent("a1"), agent("a2"), agent("a3")]),
				cluster("b", [agent("b1")]),
			],
			helpers: [],
		});
		expect(layout.orchestrator).toMatchObject({ x: 0, y: 0 });
		const a = layout.workspaces.a;
		const b = layout.workspaces.b;
		expect(dist(a)).toBeCloseTo(dist(b), -1);
		// Each Agent is closer to its own Workspace than to the other one.
		for (const id of ["a1", "a2", "a3"]) {
			expect(dist(layout.agents[id], a)).toBeLessThan(
				dist(layout.agents[id], b),
			);
		}
		// The first Workspace sits at the top.
		expect(a.y).toBeLessThan(0);
		expect(layout.agents.a1.width).toBe(AGENT_W);
		noOverlaps(layout);
	});

	it("puts Open workspace right below the Orchestrator", () => {
		const layout = layoutGraph({
			workspaces: [cluster("a", [agent("a1")])],
			helpers: [],
		});
		expect(layout.add.x).toBe(0);
		expect(layout.add.y).toBeGreaterThan(0);
		expect(layout.add.y).toBeLessThan(80);
		noOverlaps(layout);
	});

	it("keeps the ring of Workspaces as tight as nothing-overlapping allows", () => {
		const layout = layoutGraph({
			workspaces: [cluster("a", [agent("a1")]), cluster("b", [agent("b1")])],
			helpers: [],
		});
		noOverlaps(layout);
		expect(dist(layout.workspaces.a)).toBeLessThan(450);
	});

	it("never overlaps two nodes, with many Workspaces and Agents", () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			cluster(
				`w${i}`,
				Array.from({ length: (i % 4) + 1 }, (_, k) => agent(`w${i}-${k}`)),
			),
		);
		noOverlaps(layoutGraph({ workspaces: many, helpers: [agent("h1")] }));
	});

	it("never overlaps Agents round a corner, whatever their number", () => {
		for (let n = 1; n <= 14; n++) {
			noOverlaps(
				layoutGraph({
					workspaces: [
						cluster(
							"w",
							Array.from({ length: n }, (_, k) => agent(`a${k}`)),
						),
					],
					helpers: [],
				}),
			);
		}
	});

	it("rings the Orchestrator's own helpers close round it", () => {
		const layout = layoutGraph({
			workspaces: [cluster("a", [agent("a1")])],
			helpers: [agent("h1"), agent("h2")],
		});
		expect(dist(layout.helpers.h1)).toBeLessThan(dist(layout.workspaces.a));
		expect(layout.helpers.h1).not.toEqual(layout.helpers.h2);
	});
});

describe("streamPath", () => {
	it("bows a stream toward the Orchestrator", () => {
		// Two points on the right; the control point is pulled left, toward 0.
		const d = streamPath(300, -100, 300, 100, 0, 0);
		const cx = Number(d.split(" Q ")[1].split(" ")[0]);
		expect(cx).toBeLessThan(300);
	});
});

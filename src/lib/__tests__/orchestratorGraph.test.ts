import { describe, expect, it } from "vitest";
import {
	AGENT_W,
	type GraphAgent,
	graphModel,
	layoutGraph,
	nestBySpawner,
	petalPath,
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
		expect(model.petals.map((p) => p.id)).toEqual(["b", "a"]);
		expect(model.petals[1].agents.map((x) => x.paneId)).toEqual(["a1", "a3"]);
	});

	it("puts the Orchestrator's own helpers on their own, without itself", () => {
		const o = ws("o", split(term("o1"), term("h1")), "orchestrator");
		const model = graphModel({
			...input,
			workspaces: [o],
			order: [],
			openedWorkspaceIds: new Set(["o"]),
		});
		expect(model.petals).toEqual([]);
		expect(model.helpers.map((h) => h.paneId)).toEqual(["h1"]);
	});

	it("leaves out an Opened Workspace with no Agent running", () => {
		const model = graphModel({
			...input,
			workspaces: [ws("d", term("d1"))],
			order: [],
			openedWorkspaceIds: new Set(["d"]),
		});
		expect(model.petals).toEqual([]);
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
	const dist = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

	it("rings the Agents round the Orchestrator, helpers further out", () => {
		const layout = layoutGraph({
			petals: [
				{ id: "a", name: "A", agents: [agent("a1"), agent("a2", 1)] },
				{ id: "b", name: "B", agents: [agent("b1")] },
			],
			helpers: [],
		});
		expect(layout.orchestrator).toMatchObject({ x: 0, y: 0 });
		const r = dist(layout.agents.a1);
		expect(dist(layout.agents.b1)).toBeCloseTo(r, 0);
		expect(dist(layout.agents.a2)).toBeGreaterThan(r + 100);
		expect(dist(layout.add)).toBeCloseTo(r, 0);
		expect(layout.agents.a1.width).toBe(AGENT_W);
	});

	it("gives a petal an angle in proportion to its Agents, in order", () => {
		const layout = layoutGraph({
			petals: [
				{ id: "a", name: "A", agents: [agent("a1"), agent("a2"), agent("a3")] },
				{ id: "b", name: "B", agents: [agent("b1")] },
			],
			helpers: [],
		});
		const [a, b] = layout.petals;
		expect(a.end - a.start).toBeCloseTo(3 * (b.end - b.start), 5);
		expect(b.start).toBeCloseTo(a.end, 5);
		// The first petal starts at the top.
		expect(a.start).toBeCloseTo(-Math.PI / 2, 5);
	});

	it("never stacks neighbours on top of each other", () => {
		const many = Array.from({ length: 24 }, (_, i) => agent(`p${i}`));
		const layout = layoutGraph({
			petals: [{ id: "w", name: "W", agents: many }],
			helpers: [],
		});
		const pts = many.map((a) => layout.agents[a.paneId]);
		for (let i = 1; i < pts.length; i++) {
			const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
			expect(d).toBeGreaterThanOrEqual(AGENT_W);
		}
	});

	it("rings the Orchestrator's own helpers close round it", () => {
		const layout = layoutGraph({
			petals: [{ id: "a", name: "A", agents: [agent("a1")] }],
			helpers: [agent("h1"), agent("h2")],
		});
		expect(dist(layout.helpers.h1)).toBeLessThan(dist(layout.agents.a1));
		expect(layout.helpers.h1).not.toEqual(layout.helpers.h2);
	});
});

describe("paths", () => {
	it("draws a closed petal", () => {
		const d = petalPath({
			workspaceId: "w",
			name: "W",
			start: 0,
			end: 1,
			inner: 100,
			outer: 300,
			label: { x: 0, y: 0 },
		});
		expect(d.startsWith("M ")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
	});

	it("bows a stream toward the Orchestrator", () => {
		// Two points on the right; the control point is pulled left, toward 0.
		const d = streamPath(300, -100, 300, 100, 0, 0);
		const cx = Number(d.split(" Q ")[1].split(" ")[0]);
		expect(cx).toBeLessThan(300);
	});
});

import { describe, expect, it } from "vitest";
import {
	AGENT_W,
	type GraphAgent,
	graphModel,
	layoutGraph,
	nestBySpawner,
	ORCH_W,
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

const agentPtys = new Set(["x1", "x3"]);
const base = {
	panePtyMap: { a1: "x1", a2: "x2", a3: "x3" } as Record<string, string>,
	isAgentPty: (p: string) => agentPtys.has(p),
};

describe("graphModel", () => {
	it("lists live Agents of Opened Workspaces and remembered ones of the rest", () => {
		const a = ws("a", split(term("a1"), split(term("a2"), term("a3"))));
		const b = ws("b", split(term("b1", { agentId: "codex" }), term("b2")));
		const o = ws("o", term("o1", { agentId: "claude" }), "orchestrator");
		const model = graphModel({
			...base,
			workspaces: [a, b, o],
			order: ["b", "a"],
			openedWorkspaceIds: new Set(["a", "o"]),
		});
		expect(model.map((w) => w.id)).toEqual(["b", "a"]);
		expect(model[0]).toMatchObject({ opened: false });
		expect(model[0].agents.map((x) => [x.paneId, x.dormant])).toEqual([
			["b1", true],
		]);
		expect(model[1].agents.map((x) => x.paneId)).toEqual(["a1", "a3"]);
	});

	it("leaves out Workspaces with no Agents", () => {
		const model = graphModel({
			...base,
			workspaces: [ws("c", term("c1"))],
			order: [],
			openedWorkspaceIds: new Set(["c"]),
		});
		expect(model).toEqual([]);
	});
});

describe("nestBySpawner", () => {
	const ag = (paneId: string, spawnedBy?: string): GraphAgent => ({
		paneId,
		workspaceId: "w",
		tabId: "t",
		tabName: "T",
		agentId: "claude",
		handle: undefined,
		spawnedBy,
		dormant: false,
		depth: 0,
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

	it("keeps a helper whose spawner is elsewhere at the top level", () => {
		const out = nestBySpawner([ag("h", "gone")]);
		expect(out).toMatchObject([
			{ paneId: "h", depth: 0, spawnedBy: undefined },
		]);
	});

	it("keeps the members of a spawn cycle", () => {
		const out = nestBySpawner([ag("a", "b"), ag("b", "a")]);
		expect(out.map((a) => a.paneId).sort()).toEqual(["a", "b"]);
	});
});

describe("layoutGraph", () => {
	it("puts boxes in a row and centres the Orchestrator over them", () => {
		const agent = (paneId: string, depth = 0): GraphAgent => ({
			paneId,
			workspaceId: "w",
			tabId: "t",
			tabName: "T",
			agentId: undefined,
			handle: undefined,
			spawnedBy: undefined,
			dormant: false,
			depth,
		});
		const layout = layoutGraph(
			[
				{
					id: "a",
					name: "A",
					opened: true,
					agents: [agent("a1"), agent("a2", 1)],
				},
				{ id: "b", name: "B", opened: true, agents: [agent("b1")] },
			],
			10,
		);
		const a = layout.boxes.a;
		const b = layout.boxes.b;
		expect(b.x).toBeGreaterThan(a.x + a.width);
		expect(a.y).toBe(b.y);
		expect(a.width).toBeGreaterThan(b.width); // the indented helper
		expect(layout.agents.a2.x).toBeGreaterThan(layout.agents.a1.x);
		expect(layout.agents.a2.y).toBeGreaterThan(layout.agents.a1.y);
		const total = b.x + b.width;
		expect(layout.orchestrator.x + ORCH_W / 2).toBeCloseTo(total / 2, 0);
		expect(layout.agents.b1.width).toBe(AGENT_W);
	});

	it("wraps many boxes into rows that fit the shape asked for", () => {
		const one = (id: string) => ({
			id,
			name: id,
			opened: true,
			agents: [
				{
					paneId: `${id}1`,
					workspaceId: id,
					tabId: "t",
					tabName: "T",
					agentId: undefined,
					handle: undefined,
					spawnedBy: undefined,
					dormant: false,
					depth: 0,
				},
			],
		});
		const model = Array.from({ length: 20 }, (_, i) => one(`w${i}`));
		const rowsOf = (l: ReturnType<typeof layoutGraph>) =>
			new Set(Object.values(l.boxes).map((b) => b.y)).size;
		const wide = layoutGraph(model, 8);
		const square = layoutGraph(model, 1);
		expect(rowsOf(square)).toBeGreaterThan(rowsOf(wide));
		expect(rowsOf(wide)).toBeGreaterThan(1);
		// Boxes in a row never overlap.
		const firstY = Object.values(square.boxes)[0].y;
		const row0 = Object.values(square.boxes)
			.filter((b) => b.y === firstY)
			.sort((a, b) => a.x - b.x);
		for (let i = 1; i < row0.length; i++) {
			expect(row0[i].x).toBeGreaterThanOrEqual(
				row0[i - 1].x + row0[i - 1].width,
			);
		}
	});
});

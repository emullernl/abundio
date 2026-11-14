/**
 * The **Orchestrator view**'s graph (ADR-0057), as plain data: which nodes
 * exist and where they sit. Pure; `OrchestratorGraph.tsx` draws it with React
 * Flow and adds what changes every second (status, progress, streams).
 *
 * Shape: a horizontal organisation chart. The Orchestrator on the left;
 * to its right one container per **Opened workspace**, stacked in Left
 * sidebar order, its Agents (all of them, a helper right after the Agent
 * that spawned it) in one row inside it; elbow lines between them.
 */

import { parseTabLayout } from "./paneTree";
import type { PaneNode, WorkspaceWithTabs } from "./types";
import { isOrchestrator } from "./workspaceKind";

type TerminalNode = Extract<PaneNode, { type: "terminal" }>;

/** Terminal leaves in tree order, whole (handle, spawnedBy and all). */
function terminals(node: PaneNode): TerminalNode[] {
	if (node.type === "terminal") return [node];
	if (node.type === "split") {
		return [...terminals(node.first), ...terminals(node.second)];
	}
	return [];
}

export interface GraphAgent {
	paneId: string;
	workspaceId: string;
	tabId: string;
	tabName: string;
	agentId: string | undefined;
	handle: string | undefined;
	/** The pane whose Agent spawned this one, when it is in the same Workspace. */
	spawnedBy: string | undefined;
	/** Rings out from its Workspace's first ring: 0 for a top-level Agent. */
	depth: number;
}

export interface GraphWorkspace {
	id: string;
	name: string;
	agents: GraphAgent[];
}

export interface GraphModel {
	workspaces: GraphWorkspace[];
	/** Agents in the Orchestrator's own Workspace, other than the
	 *  Orchestrator itself. */
	helpers: GraphAgent[];
}

export interface GraphModelInput {
	workspaces: readonly WorkspaceWithTabs[];
	/** Left sidebar order (ids); Workspaces missing from it go last. */
	order: readonly string[];
	openedWorkspaceIds: ReadonlySet<string>;
	/** Pane → live PTY id (ADR-0020), ahead of the layout's own. */
	panePtyMap: Readonly<Record<string, string>>;
	/** PTY id → whether it is in agent mode. */
	isAgentPty: (ptyId: string) => boolean;
	/** The Orchestrator's own pane, left out of `helpers`. */
	orchestratorPaneId: string | null;
}

/** Live agent-mode panes of `ws`, in Tab then pane order. */
function agentsOf(ws: WorkspaceWithTabs, input: GraphModelInput): GraphAgent[] {
	const out: GraphAgent[] = [];
	const tabs = [...ws.tabs].sort((a, b) => a.position - b.position);
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		for (const t of terminals(layout)) {
			const ptyId = input.panePtyMap[t.id] ?? t.ptyId;
			if (!ptyId || !input.isAgentPty(ptyId)) continue;
			out.push({
				paneId: t.id,
				workspaceId: ws.id,
				tabId: tab.id,
				tabName: tab.name,
				agentId: t.agentId,
				handle: t.agentHandle,
				spawnedBy: t.spawnedBy,
				depth: 0,
			});
		}
	}
	return out;
}

/** Puts each helper right after the Agent that spawned it (depth-first), so
 *  a cluster reads as a small tree. A spawner outside the cluster (another
 *  Workspace, or gone) leaves its helper at the top level. */
export function nestBySpawner(agents: readonly GraphAgent[]): GraphAgent[] {
	const ids = new Set(agents.map((a) => a.paneId));
	const children = new Map<string, GraphAgent[]>();
	const roots: GraphAgent[] = [];
	for (const a of agents) {
		const parent =
			a.spawnedBy && a.spawnedBy !== a.paneId && ids.has(a.spawnedBy)
				? a.spawnedBy
				: undefined;
		if (parent) {
			const list = children.get(parent) ?? [];
			list.push(a);
			children.set(parent, list);
		} else {
			roots.push(a);
		}
	}
	const out: GraphAgent[] = [];
	const seen = new Set<string>();
	const walk = (a: GraphAgent, depth: number) => {
		if (seen.has(a.paneId)) return;
		seen.add(a.paneId);
		out.push({ ...a, depth, spawnedBy: depth > 0 ? a.spawnedBy : undefined });
		for (const c of children.get(a.paneId) ?? []) walk(c, depth + 1);
	};
	for (const r of roots) walk(r, 0);
	// A spawn cycle has no root: keep its members rather than drop them.
	for (const a of agents) walk(a, 0);
	return out;
}

/** The graph's content: one cluster per Opened workspace with Agents running,
 *  in sidebar order, and the Orchestrator's own helpers. */
export function graphModel(input: GraphModelInput): GraphModel {
	const rank = new Map(input.order.map((id, i) => [id, i]));
	const opened = input.workspaces
		.filter((w) => input.openedWorkspaceIds.has(w.id))
		.map((w, i) => ({ w, r: rank.get(w.id) ?? input.order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map(({ w }) => w);
	const clusters: GraphWorkspace[] = [];
	const helpers: GraphAgent[] = [];
	for (const ws of opened) {
		const agents = agentsOf(ws, input);
		if (isOrchestrator(ws)) {
			helpers.push(
				...agents.filter((a) => a.paneId !== input.orchestratorPaneId),
			);
			continue;
		}
		if (agents.length === 0) continue;
		// Every Agent circles its Workspace directly, whatever its Tab or who
		// started it; a helper sits next to the Agent that spawned it.
		clusters.push({
			id: ws.id,
			name: ws.name,
			agents: nestBySpawner(agents).map((a) => ({
				...a,
				depth: 0,
				spawnedBy: undefined,
			})),
		});
	}
	return { workspaces: clusters, helpers };
}

// ── Layout ──

export const AGENT_W = 144;
export const AGENT_H = 30;
export const ORCH_W = 210;
export const ORCH_H = 56;
export const ADD_W = 150;
export const ADD_H = 34;
/** Space between two Agents in a row. */
const AGENT_GAP = 16;
/** A container's inner padding, and the height of its name. */
const PAD = 14;
const HEADER = 24;
/** From the name down to the bus, and from the bus down to the Agents. */
const BUS_GAP = 8;
const DROP = 16;
/** Space between two containers in the stack. */
const STACK_GAP = 18;
/** From the Orchestrator's right side to the trunk, and from the trunk to
 *  the containers. */
const TRUNK_GAP = 36;
const BRANCH = 28;
/** The narrowest container, so a short name still fits. */
const MIN_CONTAINER_W = 180;
/** Room between the Orchestrator and what sits below it. */
const BELOW_GAP = 14;

export interface Point {
	x: number;
	y: number;
}

/** A node's centre and size. */
export interface Placed {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A container: its box (centre and size, like a node) and the height of
 *  the bus its Agents hang from. */
export interface Container extends Placed {
	busY: number;
}

export interface GraphLayout {
	orchestrator: Placed;
	add: Placed;
	/** By Workspace id. */
	containers: Record<string, Container>;
	/** The Orchestrator's own helpers' container, when it has helpers. */
	helperContainer: Container | null;
	/** Every Agent (and helper) by pane id. */
	agents: Record<string, Placed>;
	/** The bus each Agent hangs from, by pane id. */
	busOf: Record<string, number>;
	/** The vertical line every branch leaves from. */
	trunkX: number;
}

function rowWidth(count: number): number {
	return Math.max(
		MIN_CONTAINER_W,
		2 * PAD + count * AGENT_W + Math.max(0, count - 1) * AGENT_GAP,
	);
}

const CONTAINER_H = HEADER + BUS_GAP + DROP + AGENT_H + PAD;

/** One container whose top-left corner is (`left`, `top`), with `ids` in a
 *  row inside it. Writes the Agents into `agents`/`busOf`. */
function container(
	left: number,
	top: number,
	ids: string[],
	agents: Record<string, Placed>,
	busOf: Record<string, number>,
): Container {
	const width = rowWidth(ids.length);
	const busY = top + HEADER + BUS_GAP;
	const agentY = busY + DROP + AGENT_H / 2;
	ids.forEach((id, k) => {
		agents[id] = {
			x: left + PAD + k * (AGENT_W + AGENT_GAP) + AGENT_W / 2,
			y: agentY,
			width: AGENT_W,
			height: AGENT_H,
		};
		busOf[id] = busY;
	});
	return {
		x: left + width / 2,
		y: top + CONTAINER_H / 2,
		width,
		height: CONTAINER_H,
		busY,
	};
}

/**
 * Positions for `model`: a horizontal organisation chart. The Orchestrator
 * on the left, level with the middle of the stack, "Open workspace…" right
 * below it and its own helpers' container below that; to the right of the
 * trunk, one container per Workspace, left-aligned and stacked in order,
 * each Workspace's Agents in one row inside it.
 */
export function layoutGraph(model: GraphModel): GraphLayout {
	const trunkX = ORCH_W + TRUNK_GAP;
	const left = trunkX + BRANCH;
	const agents: Record<string, Placed> = {};
	const busOf: Record<string, number> = {};
	const containers: Record<string, Container> = {};
	let top = 0;
	for (const ws of model.workspaces) {
		containers[ws.id] = container(
			left,
			top,
			ws.agents.map((a) => a.paneId),
			agents,
			busOf,
		);
		top += CONTAINER_H + STACK_GAP;
	}
	const buses = Object.values(containers).map((c) => c.busY);
	const orchY = buses.length
		? Math.round((Math.min(...buses) + Math.max(...buses)) / 2)
		: ORCH_H / 2;
	const orchestrator: Placed = {
		x: ORCH_W / 2,
		y: orchY,
		width: ORCH_W,
		height: ORCH_H,
	};
	const add: Placed = {
		x: ORCH_W / 2,
		y: orchY + ORCH_H / 2 + BELOW_GAP + ADD_H / 2,
		width: ADD_W,
		height: ADD_H,
	};
	let helperContainer: Container | null = null;
	if (model.helpers.length > 0) {
		const width = rowWidth(model.helpers.length);
		// Its right edge stays left of the trunk, so its branch comes in from
		// the trunk like every other.
		helperContainer = container(
			Math.min(0, trunkX - BRANCH - width),
			add.y + ADD_H / 2 + STACK_GAP,
			model.helpers.map((h) => h.paneId),
			agents,
			busOf,
		);
	}
	return {
		orchestrator,
		add,
		containers,
		helperContainer,
		agents,
		busOf,
		trunkX,
	};
}

/** Where a node joins the chart's lines: the Orchestrator at the trunk, an
 *  Agent up its drop and along its bus to the trunk. Ends at the trunk. */
function toTrunk(layout: GraphLayout, id: string | "orchestrator"): Point[] {
	if (id === "orchestrator") {
		const o = layout.orchestrator;
		return [
			{ x: o.x + o.width / 2, y: o.y },
			{ x: layout.trunkX, y: o.y },
		];
	}
	const a = layout.agents[id];
	const bus = layout.busOf[id];
	return [
		{ x: a.x, y: a.y - a.height / 2 },
		{ x: a.x, y: bus },
		{ x: layout.trunkX, y: bus },
	];
}

/**
 * The route along the chart's own lines from one node to another (pane ids,
 * or "orchestrator"): up the first one's drop, along its bus, along the
 * trunk, along the other's bus and down its drop. Two Agents on the same
 * bus go straight along it. Null when either is not in the chart.
 */
export function routeBetween(
	layout: GraphLayout,
	from: string,
	to: string,
): Point[] | null {
	const known = (id: string) => id === "orchestrator" || id in layout.agents;
	if (!known(from) || !known(to) || from === to) return null;
	if (
		from !== "orchestrator" &&
		to !== "orchestrator" &&
		layout.busOf[from] === layout.busOf[to]
	) {
		const a = layout.agents[from];
		const b = layout.agents[to];
		const bus = layout.busOf[from];
		return [
			{ x: a.x, y: a.y - a.height / 2 },
			{ x: a.x, y: bus },
			{ x: b.x, y: bus },
			{ x: b.x, y: b.y - b.height / 2 },
		];
	}
	return [...toTrunk(layout, from), ...toTrunk(layout, to).reverse()];
}

/** An SVG path through `points`. */
export function polylinePath(points: readonly Point[]): string {
	return points
		.map(
			(p, i) => `${i === 0 ? "M" : "L"} ${Math.round(p.x)} ${Math.round(p.y)}`,
		)
		.join(" ");
}

/**
 * The **Orchestrator view**'s graph (ADR-0057), as plain data: which nodes
 * exist and where they sit. Pure; `OrchestratorGraph.tsx` draws it with React
 * Flow and adds what changes every second (status, progress, streams).
 *
 * Shape: the Orchestrator in the centre; each **Opened workspace** a node on
 * a ring round it, in Left sidebar order clockwise from the top; each
 * Workspace's Agents, all of them, in a ring round their Workspace, a helper
 * next to the Agent that spawned it; the Orchestrator's own
 * helpers close round the centre; and one more slot on the ring for "Open
 * workspace…".
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
export const WS_W = 150;
export const WS_H = 36;
export const ORCH_W = 210;
export const ORCH_H = 56;
export const HELPER_W = 144;
export const HELPER_H = 30;
export const ADD_W = 140;
export const ADD_H = 34;
/** Room between a Workspace's pill and its Agents' pills. */
const PILL_GAP = 34;
/** Distance between neighbouring Agents along the ring round their
 *  Workspace. Enough that two pills either side of a corner never touch. */
const AGENT_SPACING = 200;
/** Room between two neighbouring Workspace clusters. */
const CLUSTER_GAP = 24;
/** Room between the Orchestrator and the nodes right round it. */
const CENTRE_GAP = 14;
/** How much the ring of Workspaces grows per try until nothing overlaps. */
const RADIUS_STEP = 16;
/** The smallest ring of Workspaces round the Orchestrator. */
const MIN_RADIUS = 200;

/** A node's centre and size. */
export interface Placed {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface GraphLayout {
	/** Every position is a centre, with the Orchestrator at (0, 0). */
	orchestrator: Placed;
	workspaces: Record<string, Placed>;
	agents: Record<string, Placed>;
	helpers: Record<string, Placed>;
	/** The "Open workspace…" node, on the ring as one more Workspace. */
	add: Placed;
}

const TOP = -Math.PI / 2;

const at = (cx: number, cy: number, radius: number, angle: number) => ({
	x: Math.round(cx + radius * Math.cos(angle)),
	y: Math.round(cy + radius * Math.sin(angle)),
});

/** The rectangle Agents sit on round a Workspace pill: just clear of it
 *  (pill half-sizes added), grown in proportion until every Agent has
 *  `AGENT_SPACING` along its edge. Half-sizes. */
function ringBox(
	count: number,
	centre = { w: WS_W, h: WS_H },
	around = { w: AGENT_W, h: AGENT_H },
	gap = PILL_GAP,
): { hx: number; hy: number } {
	const hx0 = centre.w / 2 + around.w / 2 + gap;
	const hy0 = centre.h / 2 + around.h / 2 + gap;
	const perimeter = 4 * (hx0 + hy0);
	const grow = Math.max(1, (Math.max(count, 1) * AGENT_SPACING) / perimeter);
	return { hx: Math.round(hx0 * grow), hy: Math.round(hy0 * grow) };
}

/** Where along the rectangle's edge (clockwise from its top-left corner)
 *  the ray from its centre at `angle` meets it. */
function edgeOffset(box: { hx: number; hy: number }, angle: number): number {
	const { hx, hy } = box;
	const c = Math.cos(angle);
	const sn = Math.sin(angle);
	const t = Math.min(
		Math.abs(c) < 1e-9 ? Number.POSITIVE_INFINITY : hx / Math.abs(c),
		Math.abs(sn) < 1e-9 ? Number.POSITIVE_INFINITY : hy / Math.abs(sn),
	);
	const x = t * c;
	const y = t * sn;
	if (Math.abs(y + hy) < 1e-6) return x + hx; // top
	if (Math.abs(x - hx) < 1e-6) return 2 * hx + (y + hy); // right
	if (Math.abs(y - hy) < 1e-6) return 2 * hx + 2 * hy + (hx - x); // bottom
	return 4 * hx + 2 * hy + (hy - y); // left
}

/** The point `offset` along the rectangle's edge, clockwise from its
 *  top-left corner, about its centre. */
function edgePoint(
	box: { hx: number; hy: number },
	offset: number,
): { x: number; y: number } {
	const { hx, hy } = box;
	const per = 4 * (hx + hy);
	let d = ((offset % per) + per) % per;
	if (d < 2 * hx) return { x: -hx + d, y: -hy };
	d -= 2 * hx;
	if (d < 2 * hy) return { x: hx, y: -hy + d };
	d -= 2 * hy;
	if (d < 2 * hx) return { x: hx - d, y: hy };
	d -= 2 * hx;
	return { x: -hx, y: hy - d };
}

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) =>
	Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
	Math.abs(a.y - b.y) < (a.height + b.height) / 2;

/** The nodes right round the Orchestrator: "Open workspace…" just below it,
 *  then its own helpers on round the same ring. */
function centreRing(helperIds: string[]): {
	add: Placed;
	helpers: Record<string, Placed>;
} {
	const box = ringBox(
		helperIds.length + 1,
		{ w: ORCH_W, h: ORCH_H },
		{ w: HELPER_W, h: HELPER_H },
		CENTRE_GAP,
	);
	// Below the Orchestrator, as close as it fits.
	const add: Placed = {
		x: 0,
		y: ORCH_H / 2 + CENTRE_GAP + ADD_H / 2,
		width: ADD_W,
		height: ADD_H,
	};
	const per = 4 * (box.hx + box.hy);
	const step = per / (helperIds.length + 1);
	const bottom = edgeOffset(box, Math.PI / 2);
	const helpers: Record<string, Placed> = {};
	helperIds.forEach((id, k) => {
		const p = edgePoint(box, bottom + (k + 1) * step);
		helpers[id] = {
			x: Math.round(p.x),
			y: Math.round(p.y),
			width: HELPER_W,
			height: HELPER_H,
		};
	});
	return { add, helpers };
}

/** A Workspace's pill and its Agents, about the Workspace's centre, with
 *  the first Agent facing `mid` (away from the Orchestrator). */
function clusterBoxes(
	ws: GraphWorkspace,
	mid: number,
): { pill: Box; agents: [string, Box][] } {
	const box = ringBox(ws.agents.length);
	const per = 4 * (box.hx + box.hy);
	const step = per / Math.max(1, ws.agents.length);
	const start = edgeOffset(box, mid) + (ws.agents.length > 1 ? step / 2 : 0);
	return {
		pill: { x: 0, y: 0, width: WS_W, height: WS_H },
		agents: ws.agents.map((a, k) => {
			const p = edgePoint(box, start + k * step);
			return [
				a.paneId,
				{ x: p.x, y: p.y, width: AGENT_W, height: AGENT_H },
			] as [string, Box];
		}),
	};
}

/** How far a cluster reaches either way along the ring at angle `mid`: its
 *  boxes projected on the ring's tangent there. */
function tangentialHalf(ws: GraphWorkspace, mid: number): number {
	const tx = -Math.sin(mid);
	const ty = Math.cos(mid);
	const { pill, agents } = clusterBoxes(ws, mid);
	let half = 0;
	for (const b of [pill, ...agents.map(([, b]) => b)]) {
		const centre = Math.abs(b.x * tx + b.y * ty);
		const extent = Math.abs((b.width / 2) * tx) + Math.abs((b.height / 2) * ty);
		half = Math.max(half, centre + extent);
	}
	return half;
}

/** Angles round the ring for clusters needing `spans` each, the first
 *  centred at the top. */
function anglesFor(spans: number[]): number[] {
	const total = Math.max(
		1,
		spans.reduce((a, b) => a + b, 0),
	);
	const mids: number[] = [];
	let angle = TOP - (spans.length ? (spans[0] / total) * Math.PI : 0);
	for (const span of spans) {
		const share = (span / total) * 2 * Math.PI;
		mids.push(angle + share / 2);
		angle += share;
	}
	return mids;
}

/**
 * Positions for `model`: the Workspaces on a ring round the Orchestrator,
 * clockwise from the top in sidebar order, each given room along the ring
 * for its cluster's real width there; each Workspace's Agents evenly round
 * it, the first facing away from the Orchestrator; "Open workspace…" just
 * below the Orchestrator, its own helpers round it. The ring is as small as
 * it can be with no two nodes touching.
 */
export function layoutGraph(model: GraphModel): GraphLayout {
	const { add, helpers } = centreRing(model.helpers.map((h) => h.paneId));
	const centre: Box[] = [
		{ x: 0, y: 0, width: ORCH_W, height: ORCH_H },
		add,
		...Object.values(helpers),
	];
	const list = model.workspaces;
	// Room along the ring: first guess from equal shares, then once more
	// with the angles that guess gives.
	let mids = anglesFor(list.map(() => 1));
	for (let pass = 0; pass < 2; pass++) {
		mids = anglesFor(
			list.map((ws, i) => 2 * tangentialHalf(ws, mids[i]) + CLUSTER_GAP),
		);
	}
	const spans = list.map(
		(ws, i) => 2 * tangentialHalf(ws, mids[i]) + CLUSTER_GAP,
	);
	const circumference = spans.reduce((a, b) => a + b, 0);

	const place = (radius: number) => {
		const workspaces: Record<string, Placed> = {};
		const agents: Record<string, Placed> = {};
		list.forEach((ws, i) => {
			const c = at(0, 0, radius, mids[i]);
			workspaces[ws.id] = { ...c, width: WS_W, height: WS_H };
			for (const [id, b] of clusterBoxes(ws, mids[i]).agents) {
				agents[id] = {
					x: Math.round(c.x + b.x),
					y: Math.round(c.y + b.y),
					width: AGENT_W,
					height: AGENT_H,
				};
			}
		});
		return { workspaces, agents };
	};
	const clash = (placed: ReturnType<typeof place>) => {
		const groups = list.map((ws) => [
			placed.workspaces[ws.id],
			...ws.agents.map((a) => placed.agents[a.paneId]),
		]);
		for (let i = 0; i < groups.length; i++) {
			for (const b of groups[i]) {
				if (centre.some((c) => overlaps(b, c))) return true;
				for (let j = i + 1; j < groups.length; j++) {
					if (groups[j].some((o) => overlaps(b, o))) return true;
				}
			}
		}
		return false;
	};

	let radius = Math.max(MIN_RADIUS, Math.round(circumference / (2 * Math.PI)));
	let placed = place(radius);
	for (let tries = 0; tries < 300 && clash(placed); tries++) {
		radius += RADIUS_STEP;
		placed = place(radius);
	}

	return {
		orchestrator: { x: 0, y: 0, width: ORCH_W, height: ORCH_H },
		workspaces: placed.workspaces,
		agents: placed.agents,
		helpers,
		add,
	};
}

/**
 * The curve a call's stream follows from one centre to another: a quadratic
 * Bézier whose control point is the midpoint pulled toward the Orchestrator
 * (the origin), so streams between far-apart Agents bow inward instead of
 * cutting across other nodes. `ox`/`oy` is the origin in the same
 * coordinates as the two points.
 */
export function streamPath(
	sx: number,
	sy: number,
	tx: number,
	ty: number,
	ox: number,
	oy: number,
	pull = 0.55,
): string {
	const mx = (sx + tx) / 2;
	const my = (sy + ty) / 2;
	const cx = mx + (ox - mx) * pull;
	const cy = my + (oy - my) * pull;
	return `M ${sx} ${sy} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx} ${ty}`;
}

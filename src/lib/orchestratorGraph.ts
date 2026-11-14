/**
 * The **Orchestrator view**'s graph (ADR-0057), as plain data: which nodes
 * exist and where they sit. Pure; `OrchestratorGraph.tsx` draws it with React
 * Flow and adds what changes every second (status, progress, streams).
 *
 * Shape: a flower. The Orchestrator in the centre; one petal per **Opened
 * workspace**, its angle in proportion to its Agent count, in Left sidebar
 * order clockwise from the top; a helper one ring further out than the Agent
 * that spawned it; the Orchestrator's own helpers on a small ring round the
 * centre; and one more slot on the outer ring for "Open workspace…".
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
	/** The pane whose Agent spawned this one, when it is in the same petal. */
	spawnedBy: string | undefined;
	/** Rings out from its petal's first ring: 0 for a top-level Agent. */
	depth: number;
}

export interface GraphWorkspace {
	id: string;
	name: string;
	agents: GraphAgent[];
}

export interface GraphModel {
	petals: GraphWorkspace[];
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
 *  a petal reads as a small tree. A spawner outside the petal (another
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

/** The flower's content: a petal per Opened workspace with Agents running,
 *  in sidebar order, and the Orchestrator's own helpers. */
export function graphModel(input: GraphModelInput): GraphModel {
	const rank = new Map(input.order.map((id, i) => [id, i]));
	const opened = input.workspaces
		.filter((w) => input.openedWorkspaceIds.has(w.id))
		.map((w, i) => ({ w, r: rank.get(w.id) ?? input.order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map(({ w }) => w);
	const petals: GraphWorkspace[] = [];
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
		petals.push({ id: ws.id, name: ws.name, agents: nestBySpawner(agents) });
	}
	return { petals, helpers };
}

// ── Layout ──

export const AGENT_W = 184;
export const AGENT_H = 48;
export const ORCH_W = 210;
export const ORCH_H = 56;
export const HELPER_W = 150;
export const HELPER_H = 40;
export const ADD_W = 150;
export const ADD_H = 40;
/** Space each Agent needs along the outer ring. */
const SLOT_ARC = 220;
/** The smallest first ring, so a small flower is not cramped round the
 *  Orchestrator. */
const MIN_RADIUS = 260;
/** Distance from one ring of Agents to the next (helpers). */
const RING_STEP = 210;
/** The Orchestrator's own helpers. */
const HELPER_RADIUS = 125;

/** A node's centre and size. */
export interface Placed {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Petal {
	workspaceId: string;
	name: string;
	/** Angles in radians, clockwise from the top (screen coordinates). */
	start: number;
	end: number;
	/** Radius of its inner and outer edge. */
	inner: number;
	outer: number;
	/** Where its name goes, past the outer edge. */
	label: { x: number; y: number };
}

export interface GraphLayout {
	/** Every position is a centre, with the Orchestrator at (0, 0). */
	orchestrator: Placed;
	agents: Record<string, Placed>;
	helpers: Record<string, Placed>;
	petals: Petal[];
	/** The "Open workspace…" node. */
	add: Placed;
}

const TOP = -Math.PI / 2;

const at = (radius: number, angle: number) => ({
	x: Math.round(radius * Math.cos(angle)),
	y: Math.round(radius * Math.sin(angle)),
});

/** Positions for `model`: see the module comment. */
export function layoutGraph(model: GraphModel): GraphLayout {
	const count = model.petals.reduce((n, p) => n + p.agents.length, 0);
	const slots = count + 1; // + the "Open workspace…" slot
	const step = (2 * Math.PI) / slots;
	const radius = Math.max(
		MIN_RADIUS,
		Math.round((slots * SLOT_ARC) / (2 * Math.PI)),
	);

	const agents: Record<string, Placed> = {};
	const petals: Petal[] = [];
	let slot = 0;
	for (const ws of model.petals) {
		const start = TOP + slot * step;
		const maxDepth = Math.max(0, ...ws.agents.map((a) => a.depth));
		ws.agents.forEach((a, i) => {
			const angle = TOP + (slot + i + 0.5) * step;
			agents[a.paneId] = {
				...at(radius + a.depth * RING_STEP, angle),
				width: AGENT_W,
				height: AGENT_H,
			};
		});
		slot += ws.agents.length;
		const end = TOP + slot * step;
		const outer = radius + maxDepth * RING_STEP + AGENT_H + 40;
		petals.push({
			workspaceId: ws.id,
			name: ws.name,
			start,
			end,
			inner: Math.round(radius * 0.55),
			outer,
			label: at(outer + 26, (start + end) / 2),
		});
	}

	const helpers: Record<string, Placed> = {};
	const hStep = (2 * Math.PI) / Math.max(1, model.helpers.length);
	model.helpers.forEach((h, i) => {
		helpers[h.paneId] = {
			...at(HELPER_RADIUS + ORCH_H / 2, TOP + Math.PI / 4 + i * hStep),
			width: HELPER_W,
			height: HELPER_H,
		};
	});

	return {
		orchestrator: { x: 0, y: 0, width: ORCH_W, height: ORCH_H },
		agents,
		helpers,
		petals,
		add: {
			...at(radius, TOP + (slots - 0.5) * step),
			width: ADD_W,
			height: ADD_H,
		},
	};
}

/**
 * An SVG path for a petal: a rounded wedge from `inner` to `outer` between
 * its angles, drawn about the origin.
 */
export function petalPath(p: Petal, gap = 0.035): string {
	const a0 = p.start + gap;
	const a1 = Math.max(a0 + 0.01, p.end - gap);
	const pt = (r: number, a: number) =>
		`${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
	const large = a1 - a0 > Math.PI ? 1 : 0;
	return [
		`M ${pt(p.inner, a0)}`,
		`L ${pt(p.outer, a0)}`,
		`A ${p.outer} ${p.outer} 0 ${large} 1 ${pt(p.outer, a1)}`,
		`L ${pt(p.inner, a1)}`,
		`A ${p.inner} ${p.inner} 0 ${large} 0 ${pt(p.inner, a0)}`,
		"Z",
	].join(" ");
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

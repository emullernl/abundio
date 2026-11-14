/**
 * The **Orchestrator view**'s graph (ADR-0057), as plain data: which boxes
 * exist and where they sit. Pure; `OrchestratorGraph.tsx` draws it with React
 * Flow and adds what changes every second (status, progress, animations).
 *
 * Shape: the Orchestrator on top; under it one box per Workspace of the
 * Profile, in Left sidebar order; inside each box its Agents, a helper indented
 * under the Agent that spawned it. A Workspace that is not Opened shows the
 * Agents its layout remembers, greyed (**dormant**).
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
	/** The pane whose Agent spawned this one, when it is in the same box. */
	spawnedBy: string | undefined;
	/** Not running: its Workspace is not Opened. */
	dormant: boolean;
	/** Nesting under its spawner, 0 for a top-level Agent. */
	depth: number;
}

export interface GraphWorkspace {
	id: string;
	name: string;
	opened: boolean;
	agents: GraphAgent[];
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
}

/** Agents in `ws`, in Tab then pane order, live or dormant. */
function agentsOf(
	ws: WorkspaceWithTabs,
	opened: boolean,
	input: GraphModelInput,
): GraphAgent[] {
	const out: GraphAgent[] = [];
	const tabs = [...ws.tabs].sort((a, b) => a.position - b.position);
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		for (const t of terminals(layout)) {
			if (opened) {
				const ptyId = input.panePtyMap[t.id] ?? t.ptyId;
				if (!ptyId || !input.isAgentPty(ptyId)) continue;
			} else if (!t.agentId) {
				continue;
			}
			out.push({
				paneId: t.id,
				workspaceId: ws.id,
				tabId: tab.id,
				tabName: tab.name,
				agentId: t.agentId,
				handle: t.agentHandle,
				spawnedBy: t.spawnedBy,
				dormant: !opened,
				depth: 0,
			});
		}
	}
	return nestBySpawner(out);
}

/** Puts each helper right after the Agent that spawned it (depth-first), so
 *  a box reads as a small tree. A spawner outside the box (another Workspace,
 *  or gone) leaves its helper at the top level. */
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

/** Every Workspace of the Profile that has Agents, in sidebar order. The
 *  Orchestrator workspace is the graph's top, never a box. */
export function graphModel(input: GraphModelInput): GraphWorkspace[] {
	const rank = new Map(input.order.map((id, i) => [id, i]));
	const list = input.workspaces
		.filter((w) => !isOrchestrator(w))
		.map((w, i) => ({ w, r: rank.get(w.id) ?? input.order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map(({ w }) => w);
	const out: GraphWorkspace[] = [];
	for (const ws of list) {
		const opened = input.openedWorkspaceIds.has(ws.id);
		const agents = agentsOf(ws, opened, input);
		if (agents.length === 0) continue;
		out.push({ id: ws.id, name: ws.name, opened, agents });
	}
	return out;
}

// ── Layout ──

export const AGENT_W = 210;
export const AGENT_H = 54;
export const ORCH_W = 240;
export const ORCH_H = 58;
const AGENT_GAP = 8;
const INDENT = 18;
const BOX_PAD = 12;
const BOX_HEADER = 30;
const BOX_GAP = 28;
const LEVEL_GAP = 64;

export interface Placed {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface GraphLayout {
	orchestrator: Placed;
	/** By Workspace id, absolute. */
	boxes: Record<string, Placed>;
	/** By pane id, relative to its box (React Flow's `parentId`). */
	agents: Record<string, Placed>;
}

/**
 * Positions for `model`. The boxes run in rows under the Orchestrator,
 * wrapped so the whole graph has about the `aspect` (width / height) of the
 * area it is drawn in; each row is centred, and the Orchestrator is centred
 * over the widest row.
 */
export function layoutGraph(
	model: readonly GraphWorkspace[],
	aspect = 3,
): GraphLayout {
	const sized = model.map((ws) => {
		const maxDepth = Math.max(0, ...ws.agents.map((a) => a.depth));
		return {
			ws,
			width: AGENT_W + 2 * BOX_PAD + maxDepth * INDENT,
			height:
				BOX_HEADER +
				ws.agents.length * (AGENT_H + AGENT_GAP) -
				AGENT_GAP +
				BOX_PAD,
		};
	});
	// The row width that gives the asked-for shape: area = W * H with
	// W / H = aspect, so W = sqrt(area * aspect). Never narrower than a box.
	const area = sized.reduce(
		(sum, b) => sum + (b.width + BOX_GAP) * (b.height + BOX_GAP),
		0,
	);
	const widest = Math.max(0, ...sized.map((b) => b.width));
	const maxRow = Math.max(widest, Math.sqrt(area * Math.max(0.5, aspect)));

	const rows: (typeof sized)[] = [];
	let row: typeof sized = [];
	let rowWidth = 0;
	for (const b of sized) {
		const next = rowWidth + (row.length > 0 ? BOX_GAP : 0) + b.width;
		if (row.length > 0 && next > maxRow) {
			rows.push(row);
			row = [];
			rowWidth = 0;
		}
		rowWidth += (row.length > 0 ? BOX_GAP : 0) + b.width;
		row.push(b);
	}
	if (row.length > 0) rows.push(row);

	const widthOf = (r: typeof sized) =>
		r.reduce((w, b) => w + b.width, 0) + Math.max(0, r.length - 1) * BOX_GAP;
	const total = Math.max(0, ...rows.map(widthOf));

	const boxes: Record<string, Placed> = {};
	const agents: Record<string, Placed> = {};
	let y = ORCH_H + LEVEL_GAP;
	for (const r of rows) {
		let x = Math.round((total - widthOf(r)) / 2);
		for (const { ws, width, height } of r) {
			ws.agents.forEach((a, i) => {
				agents[a.paneId] = {
					x: BOX_PAD + a.depth * INDENT,
					y: BOX_HEADER + i * (AGENT_H + AGENT_GAP),
					width: AGENT_W,
					height: AGENT_H,
				};
			});
			boxes[ws.id] = { x, y, width, height };
			x += width + BOX_GAP;
		}
		y += Math.max(...r.map((b) => b.height)) + BOX_GAP;
	}
	return {
		orchestrator: {
			x: Math.round(total / 2 - ORCH_W / 2),
			y: 0,
			width: ORCH_W,
			height: ORCH_H,
		},
		boxes,
		agents,
	};
}

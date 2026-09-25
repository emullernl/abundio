// Dormant workspaces for the Fleet Console's **Relaunch** — see the Dormant
// workspace, Add agent and Relaunch entries in CONTEXT.md. Pure: derived from
// the saved layouts, the Window's Opened set and the known Agents.

import { collectAgentPanes, parseTabLayout } from "./paneTree";
import type { WorkspaceWithTabs } from "./types";
import {
	buildWorkspaceRows,
	type WorktreeGroupFacts,
} from "./worktreeGrouping";

type RememberedAgent = { paneId: string; agentId: string };

// The parse is a pure function of the layout string, and `workspaces` gets a
// new identity on ordinary events (ptyId write-back, tab edits), so cache it.
// Bounded crudely: cleared whole when it grows past the cap.
const LAYOUT_CACHE_CAP = 500;
const layoutAgentsCache = new Map<string, readonly RememberedAgent[]>();

function layoutAgents(layoutJson: string): readonly RememberedAgent[] {
	const hit = layoutAgentsCache.get(layoutJson);
	if (hit) return hit;
	const layout = parseTabLayout(layoutJson);
	const agents = layout ? collectAgentPanes(layout) : [];
	if (layoutAgentsCache.size >= LAYOUT_CACHE_CAP) layoutAgentsCache.clear();
	layoutAgentsCache.set(layoutJson, agents);
	return agents;
}

/** Every terminal in the Workspace whose layout remembers an Agent, in Tab
 *  then pane order. */
export function rememberedAgents(ws: WorkspaceWithTabs): RememberedAgent[] {
	return ws.tabs.flatMap((tab) => layoutAgents(tab.layoutJson));
}

/** The panes a Relaunch will turn back into Agents — those whose remembered
 *  Agent Abundio still knows. The rest come back as plain shells, so they get
 *  no tile. */
export function relaunchablePanes(
	ws: WorkspaceWithTabs,
	knownAgentIds: ReadonlySet<string>,
): string[] {
	return rememberedAgents(ws)
		.filter((a) => knownAgentIds.has(a.agentId))
		.map((a) => a.paneId);
}

/** The Agent ids a Relaunch would actually bring back: an id Abundio no longer
 *  knows comes up as a plain shell, so it is left out. */
export function relaunchableAgentIds(
	ws: WorkspaceWithTabs,
	knownAgentIds: ReadonlySet<string>,
): string[] {
	return rememberedAgents(ws)
		.map((a) => a.agentId)
		.filter((id) => knownAgentIds.has(id));
}

/** Not Opened in this Window, and would bring at least one Agent back. */
export function isDormant(
	ws: WorkspaceWithTabs,
	openedIds: ReadonlySet<string>,
	knownAgentIds: ReadonlySet<string>,
): boolean {
	return (
		!openedIds.has(ws.id) && relaunchableAgentIds(ws, knownAgentIds).length > 0
	);
}

export function dormantWorkspaces(
	workspaces: WorkspaceWithTabs[],
	openedIds: ReadonlySet<string>,
	knownAgentIds: ReadonlySet<string>,
): WorkspaceWithTabs[] {
	return workspaces.filter((w) => isDormant(w, openedIds, knownAgentIds));
}

/**
 * Whether the Console's workspace picker lists `ws`: it has Agents on the grid
 * now, or would bring some back when opened. A Workspace with neither adds
 * nothing to the Console, so it is left out.
 */
export function hasFleetAgents(
	ws: WorkspaceWithTabs,
	knownAgentIds: ReadonlySet<string>,
	liveTiles: number,
): boolean {
	return liveTiles > 0 || relaunchableAgentIds(ws, knownAgentIds).length > 0;
}

export interface AgentCount {
	agentId: string;
	count: number;
}

/** Group Agent ids into counts, in the order each is first seen. */
export function agentCounts(agentIds: string[]): AgentCount[] {
	const counts = new Map<string, number>();
	for (const id of agentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	return [...counts].map(([agentId, count]) => ({ agentId, count }));
}

export type RelaunchRow =
	| {
			kind: "workspace";
			workspace: WorkspaceWithTabs;
			agents: AgentCount[];
			/** A Linked worktree, drawn under its Primary. */
			indent: boolean;
	  }
	/** A Primary that is not Dormant — Opened, or closed with no Agents — whose
	 *  Linked worktrees are: a plain label. */
	| { kind: "heading"; workspace: WorkspaceWithTabs; opened: boolean };

/**
 * The Relaunch list, grouped like the Console's workspace picker: Left-sidebar
 * order, a Worktree set's Linked worktrees under their Primary. Only Dormant
 * workspaces are rows; a set with nothing Dormant is left out.
 */
export function buildRelaunchRows(
	workspaces: WorkspaceWithTabs[],
	facts: Record<string, WorktreeGroupFacts | undefined>,
	openedIds: ReadonlySet<string>,
	knownAgentIds: ReadonlySet<string>,
): RelaunchRow[] {
	const row = (w: WorkspaceWithTabs, indent: boolean): RelaunchRow | null =>
		isDormant(w, openedIds, knownAgentIds)
			? {
					kind: "workspace",
					workspace: w,
					agents: agentCounts(relaunchableAgentIds(w, knownAgentIds)),
					indent,
				}
			: null;

	const out: RelaunchRow[] = [];
	for (const r of buildWorkspaceRows(workspaces, facts)) {
		if (r.kind === "standalone") {
			const one = row(r.workspace, false);
			if (one) out.push(one);
			continue;
		}
		const linked = r.linked
			.map((w) => row(w, true))
			.filter((x): x is RelaunchRow => !!x);
		const primary = row(r.primary, false);
		if (primary) out.push(primary);
		else if (linked.length > 0)
			out.push({
				kind: "heading",
				workspace: r.primary,
				opened: openedIds.has(r.primary.id),
			});
		out.push(...linked);
	}
	return out;
}

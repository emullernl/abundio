// Dormant workspaces for the Fleet Console's **Relaunch** — see the Dormant
// workspace, Add agent and Relaunch entries in CONTEXT.md. Pure: derived from
// the saved layouts, the Window's Opened set and the known Agents.

import { collectAgentPanes, parseTabLayout } from "./paneTree";
import type { WorkspaceWithTabs } from "./types";
import {
	buildWorkspaceRows,
	type WorktreeGroupFacts,
} from "./worktreeGrouping";

/** Every terminal in the Workspace whose layout remembers an Agent, in Tab
 *  then pane order. */
export function rememberedAgents(
	ws: WorkspaceWithTabs,
): { paneId: string; agentId: string }[] {
	const out: { paneId: string; agentId: string }[] = [];
	for (const tab of ws.tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (layout) out.push(...collectAgentPanes(layout));
	}
	return out;
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
	/** An Opened Primary whose Linked worktrees are Dormant: a plain label. */
	| { kind: "heading"; workspace: WorkspaceWithTabs };

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
			out.push({ kind: "heading", workspace: r.primary });
		out.push(...linked);
	}
	return out;
}

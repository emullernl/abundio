/**
 * Pure helpers for the **Orchestrator** (ADR-0057): which pane is the
 * Orchestrator's, which pane to start it in, and how that pane is stamped.
 * The session side (store, IPC, PTYs) is `orchestratorSession.ts`.
 */

import { handleKey } from "./agentHandle";
import {
	collectTerminalIds,
	findNode,
	parseTabLayout,
	setAgentHandle,
	setAgentId,
} from "./paneTree";
import type { CodingAgent, PaneNode, Tab } from "./types";
import { isOrchestrator } from "./workspaceKind";

/** The handle every Orchestrator has. Kept for it in Rust (`agent_names`). */
export const ORCHESTRATOR_HANDLE = "Orchestrator";

const ORCHESTRATOR_KEY = handleKey(ORCHESTRATOR_HANDLE);

export interface PaneRef {
	tabId: string;
	paneId: string;
}

/** The Profile's Orchestrator workspace among the store's Workspaces. */
export function findOrchestratorWorkspace<
	T extends { id: string; profileId: string; kind?: string },
>(workspaces: readonly T[], profileId: string): T | undefined {
	return workspaces.find(
		(w) =>
			w.profileId === profileId &&
			isOrchestrator(w as { id: string; kind?: "work" | "orchestrator" }),
	);
}

function terminalNode(
	layout: PaneNode,
	paneId: string,
): Extract<PaneNode, { type: "terminal" }> | null {
	const node = findNode(layout, paneId);
	return node?.type === "terminal" ? node : null;
}

/** The pane that carries the Orchestrator handle, wherever it is. */
export function orchestratorPane(tabs: readonly Tab[]): PaneRef | null {
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		for (const paneId of collectTerminalIds(layout)) {
			const handle = terminalNode(layout, paneId)?.agentHandle;
			if (handle && handleKey(handle) === ORCHESTRATOR_KEY) {
				return { tabId: tab.id, paneId };
			}
		}
	}
	return null;
}

/**
 * Where the Orchestrator starts: the pane that already carries its handle,
 * else the first terminal pane of the first Tab. `null` when the Workspace
 * has no terminal pane at all (every Tab closed).
 */
export function startPane(tabs: readonly Tab[]): PaneRef | null {
	const own = orchestratorPane(tabs);
	if (own) return own;
	const sorted = [...tabs].sort((a, b) => a.position - b.position);
	for (const tab of sorted) {
		const layout = parseTabLayout(tab.layoutJson);
		const paneId = layout ? collectTerminalIds(layout)[0] : undefined;
		if (paneId) return { tabId: tab.id, paneId };
	}
	return null;
}

/** Whether `paneId` in `layout` already runs (or is set to run) `agentId`. */
export function paneRunsAgent(
	layout: PaneNode,
	paneId: string,
	agentId: string,
): boolean {
	return terminalNode(layout, paneId)?.agentId === agentId;
}

/** `layout` with `paneId` stamped as the Orchestrator: its Agent and its
 *  handle. A different Agent before it loses its session (`setAgentId`). */
export function stampOrchestrator(
	layout: PaneNode,
	paneId: string,
	agentId: string,
): PaneNode {
	const withAgent = setAgentId(layout, paneId, agentId);
	return setAgentHandle(withAgent, paneId, ORCHESTRATOR_HANDLE);
}

/** The Agents offered in the picker: the switched-on ones, Claude Code first
 *  (best tested with the abundio skill), otherwise in Settings order. */
export function pickerAgents(agents: readonly CodingAgent[]): CodingAgent[] {
	const on = agents.filter((a) => a.enabled);
	const claude = on.filter((a) => a.id === "claude");
	return [...claude, ...on.filter((a) => a.id !== "claude")];
}

/** The launch line for `agent` (its command and fixed args). */
export function launchCommand(agent: CodingAgent): string {
	return [agent.command, ...(agent.args ?? [])].join(" ");
}

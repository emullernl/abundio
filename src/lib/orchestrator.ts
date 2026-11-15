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
	replaceNode,
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

/** What the Orchestrator's Agent last reported about itself. */
export interface OrchestratorSession {
	agentId: string;
	sessionId: string;
}

/**
 * The Agent and **Agent session id** of the Orchestrator's pane `own` (from
 * `orchestratorPane`, so its caller parses no layout twice), or `null` when
 * it has no Agent or no id yet. Remembered while the Agent runs, because its
 * exit wipes both from the pane, and picking the same Agent again resumes by
 * that id (ADR-0060). Pure.
 */
export function orchestratorSessionOf(
	tabs: readonly Tab[],
	own: PaneRef,
): OrchestratorSession | null {
	const tab = tabs.find((t) => t.id === own.tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	const node = layout ? terminalNode(layout, own.paneId) : undefined;
	if (!node?.agentId || !node.agentSessionId) return null;
	return { agentId: node.agentId, sessionId: node.agentSessionId };
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
 *  handle, and no remembered folder. A different Agent before it loses its session (`setAgentId`). */
export function stampOrchestrator(
	layout: PaneNode,
	paneId: string,
	agentId: string,
): PaneNode {
	const withAgent = setAgentId(layout, paneId, agentId);
	const named = setAgentHandle(withAgent, paneId, ORCHESTRATOR_HANDLE);
	// It always starts in its own folder, never a remembered other one.
	const node = findNode(named, paneId);
	if (node?.type !== "terminal" || node.cwd === undefined) return named;
	const { cwd: _drop, ...rest } = node;
	return replaceNode(named, paneId, rest);
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

/** Whether `paneId` is the **Orchestrator**'s own pane (the one carrying its
 *  handle) in an Orchestrator workspace among `workspaces`. Its helpers'
 *  panes are not. Only those Workspaces' layouts are read. */
export function isOrchestratorPane(
	workspaces: readonly {
		id: string;
		kind?: "work" | "orchestrator";
		tabs: readonly Tab[];
	}[],
	paneId: string,
): boolean {
	return workspaces.some(
		(ws) => isOrchestrator(ws) && orchestratorPane(ws.tabs)?.paneId === paneId,
	);
}

// ── After an exit ──

/**
 * Whether the Orchestrator's Agent has just exited in a pane that is still
 * there: the pane that carried its handle no longer does, but still exists
 * as a terminal. A closed pane (or a closed Tab) is not an exit.
 */
export function agentLeftPane(
	tabs: readonly Tab[],
	previousPaneId: string | null,
): boolean {
	if (!previousPaneId || orchestratorPane(tabs)) return false;
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (layout && findNode(layout, previousPaneId)?.type === "terminal") {
			return true;
		}
	}
	return false;
}

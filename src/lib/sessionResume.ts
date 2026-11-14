// **Session resume** (ADR-0050): the line typed to relaunch a pane's
// remembered Agent on Workspace open or a Bundle restart.

import { useSettingsStore } from "../stores/settingsStore";
import { agentRelaunchCommandFor } from "./agents";
import { parseTabLayout } from "./paneTree";
import type { PaneNode, WorkspaceWithTabs } from "./types";

type TerminalNode = Extract<PaneNode, { type: "terminal" }>;

/** The folder a pane's Agent relaunches in: the pane's last known folder,
 *  else its Workspace's. "Most recent session" is looked up here. */
export function launchFolder(node: TerminalNode, rootFolder: string): string {
	return node.cwd || rootFolder;
}

function key(agentId: string, folder: string): string {
	return `${agentId}\u0000${folder}`;
}

/**
 * How many panes remember each Agent in each launch folder, across every
 * given Workspace. A pane is **alone** when its count is 1: only then can it
 * take the folder's "most recent session" without grabbing another pane's.
 * Counts all Workspaces, not only the ones relaunching, because a pane that
 * stays put still owns its session in that folder. Pure.
 */
export function countAgentPanesByFolder(
	workspaces: WorkspaceWithTabs[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const ws of workspaces) {
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			for (const node of terminalNodes(layout)) {
				if (!node.agentId) continue;
				const k = key(node.agentId, launchFolder(node, ws.rootFolder));
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
		}
	}
	return counts;
}

export function isAloneInFolder(
	counts: Map<string, number>,
	agentId: string,
	folder: string,
): boolean {
	return (counts.get(key(agentId, folder)) ?? 0) <= 1;
}

/**
 * The relaunch line for one pane, from the live settings: its session by id,
 * the folder's latest session when alone, or the plain command. Undefined
 * when the pane remembers no Agent, or one that no longer exists.
 */
export function relaunchCommandForPane(
	node: TerminalNode,
	rootFolder: string,
	counts: Map<string, number>,
): string | undefined {
	if (!node.agentId) return undefined;
	const settings = useSettingsStore.getState();
	return agentRelaunchCommandFor(settings.agents, node.agentId, {
		sessionId: node.agentSessionId,
		alone: isAloneInFolder(
			counts,
			node.agentId,
			launchFolder(node, rootFolder),
		),
		resume: settings.resumeAgentSessions,
	});
}

/** Terminal leaves of a layout, in tree order. */
export function terminalNodes(node: PaneNode): TerminalNode[] {
	if (node.type === "terminal") return [node];
	if (node.type === "split") {
		return [...terminalNodes(node.first), ...terminalNodes(node.second)];
	}
	return [];
}

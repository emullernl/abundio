// Restarting every live PTY in a Workspace, so a change to its injected
// Environment Bundle reaches terminals that are already open.
//
// The selector below is pure and takes plain data — that is what makes the
// "which panes are live" rule testable, since it is the part with real edge
// cases (unmounted panes, stale layout ptyIds, non-terminal nodes).

import type { PtyActivityEntry } from "../stores/ptyActivityStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { agentCommandFor } from "./agents";
import { parseTabLayout } from "./paneTree";
import { setPendingAgent } from "./pendingAgentRegistry";
import {
	killUnmountedPanePty,
	livePtyIdByPane,
	restartPanePty,
} from "./terminalManager";
import type { PaneNode, PtyActivityState, WorkspaceWithTabs } from "./types";

export interface LivePane {
	paneId: string;
	ptyId: string;
	tabId: string;
	tabName: string;
	/** Terminal title, for telling two shells apart in the confirm list. */
	title: string;
	agentId?: string;
	state: PtyActivityState;
	cwd: string;
	/** False when the pane has a PTY but no mounted xterm instance. */
	mounted: boolean;
}

/**
 * Live panes of a Workspace.
 *
 * PTY-id resolution is `instance ?? panePtyMap`, never `node.ptyId` — the layout
 * copy is written back lazily and goes stale, so trusting it would kill the
 * wrong process (ADR-0020, `teardownTerminal`).
 *
 * Pure: everything comes in as data so the rule can be tested without stores.
 */
export function pickLivePanes(
	workspace: WorkspaceWithTabs,
	panePtyMap: Record<string, string>,
	instancePtyIdByPane: Record<string, string>,
	activities: Record<string, PtyActivityEntry>,
	titles: Record<string, string>,
): LivePane[] {
	const out: LivePane[] = [];

	for (const tab of workspace.tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;

		for (const node of terminalNodes(layout)) {
			const ptyId = instancePtyIdByPane[node.id] || panePtyMap[node.id] || "";
			// No live PTY: nothing to restart. The pane will spawn with the current
			// environment whenever it is first opened.
			if (!ptyId) continue;

			out.push({
				paneId: node.id,
				ptyId,
				tabId: tab.id,
				tabName: tab.name,
				title: titles[node.id] ?? "",
				agentId: node.agentId,
				state: activities[ptyId]?.state ?? "idle",
				cwd: node.cwd ?? workspace.rootFolder,
				mounted: instancePtyIdByPane[node.id] !== undefined,
			});
		}
	}

	return out;
}

/** Terminal leaves of a layout, in tree order. File and preview panes have no
 *  PTY and are skipped. */
function terminalNodes(
	node: PaneNode,
): Array<Extract<PaneNode, { type: "terminal" }>> {
	if (node.type === "terminal") return [node];
	if (node.type === "split") {
		return [...terminalNodes(node.first), ...terminalNodes(node.second)];
	}
	return [];
}

/** `pickLivePanes` bound to the live stores. */
export function collectLivePanes(workspaceId: string): LivePane[] {
	const workspace = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	if (!workspace) return [];

	const act = usePtyActivityStore.getState();
	return pickLivePanes(
		workspace,
		act.panePtyMap,
		livePtyIdByPane(),
		act.activities,
		act.titles,
	);
}

/**
 * Kill and respawn every live PTY in a Workspace so they pick up the current
 * injected Bundle. Agent panes relaunch through the same pendingAgentRegistry
 * path a cold start uses — a NEW agent session, not a resumed one.
 *
 * Sequential rather than `Promise.all`: N shells starting at once all race
 * `fit()` and `pty.resize` on shared xterm machinery, which is the class of race
 * the reset filter exists to paper over.
 */
export async function restartWorkspacePtys(
	workspaceId: string,
): Promise<{ restarted: number; failed: number }> {
	const panes = collectLivePanes(workspaceId);
	const agents = useSettingsStore.getState().agents;
	let restarted = 0;
	let failed = 0;

	for (const pane of panes) {
		const command = agentCommandFor(agents, pane.agentId);
		try {
			if (pane.mounted) {
				await restartPanePty(pane.paneId, {
					cwd: pane.cwd,
					agentCommand: command,
					preserveScrollback: true,
				});
			} else {
				restartUnmountedPane(pane, command);
			}
			restarted++;
		} catch {
			failed++;
		}
	}

	return { restarted, failed };
}

/**
 * An unmounted pane has a PTY but no xterm instance. Kill the process and clear
 * the layout's ptyId so the next mount takes the ordinary cold-start path.
 *
 * Deliberately spawns nothing now: reusing cold start is what stops this
 * becoming a second, divergent spawn implementation.
 */
function restartUnmountedPane(pane: LivePane, agentCommand?: string): void {
	killUnmountedPanePty(pane.paneId, pane.ptyId);

	const store = useWorkspaceStore.getState();
	const workspace = store.findWorkspaceForPane(pane.paneId);
	const tab = workspace?.tabs.find((t) => t.id === pane.tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	if (tab && layout) {
		store.updateLayoutLocal(tab.id, clearPtyId(layout, pane.paneId));
	}

	if (agentCommand) setPendingAgent(pane.paneId, { command: agentCommand });
}

/** Blank one pane's ptyId, leaving the rest of the tree untouched. */
function clearPtyId(node: PaneNode, paneId: string): PaneNode {
	if (node.type === "terminal") {
		return node.id === paneId ? { ...node, ptyId: "" } : node;
	}
	if (node.type === "split") {
		return {
			...node,
			first: clearPtyId(node.first, paneId),
			second: clearPtyId(node.second, paneId),
		};
	}
	return node;
}

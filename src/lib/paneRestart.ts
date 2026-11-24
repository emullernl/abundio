// Restarting every live PTY in a Workspace, so a change to its injected
// Environment Bundle reaches terminals that are already open.
//
// The selector below is pure and takes plain data — that is what makes the
// "which panes are live" rule testable, since it is the part with real edge
// cases (unmounted panes, stale layout ptyIds, non-terminal nodes).

import type { PtyActivityEntry } from "../stores/ptyActivityStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { containsPane, parseTabLayout } from "./paneTree";
import {
	type PendingTask,
	setPendingAgent,
	setPendingTask,
} from "./pendingAgentRegistry";
import { relaunchCommandForPane, terminalNodes } from "./sessionResume";
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
	/** The pane's remembered **Agent session id**, for a Session resume. */
	agentSessionId?: string;
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
				agentSessionId: node.agentSessionId,
				state: activities[ptyId]?.state ?? "idle",
				cwd: node.cwd ?? workspace.rootFolder,
				mounted: instancePtyIdByPane[node.id] !== undefined,
			});
		}
	}

	return out;
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
 * path a cold start uses, resuming their session when they can (**Session
 * resume**, ADR-0050).
 *
 * Sequential rather than `Promise.all`: N shells starting at once all race
 * `fit()` and `pty.resize` on shared xterm machinery, which is the class of race
 * the reset filter exists to paper over.
 */
export async function restartWorkspacePtys(
	workspaceId: string,
): Promise<{ restarted: number; failed: number }> {
	const panes = collectLivePanes(workspaceId);
	let restarted = 0;
	let failed = 0;

	for (const pane of panes) {
		try {
			await restartLivePane(pane);
			restarted++;
		} catch {
			failed++;
		}
	}

	return { restarted, failed };
}

/** Kill and respawn one live pane, relaunching its Agent with **Session
 *  resume** when it has one. */
async function restartLivePane(pane: LivePane): Promise<void> {
	const command = relaunchCommandForPane({
		type: "terminal",
		id: pane.paneId,
		ptyId: pane.ptyId,
		agentId: pane.agentId,
		agentSessionId: pane.agentSessionId,
		cwd: pane.cwd,
	});
	if (pane.mounted) {
		await restartPanePty(pane.paneId, {
			cwd: pane.cwd,
			agentCommand: command,
			preserveScrollback: true,
		});
	} else {
		restartUnmountedPane(pane, command);
	}
}

/**
 * A Joined profile's Workspace open in this Window, after its Host came back
 * (phase 10): a pane whose PTY died with the Host (a restart, a reboot)
 * starts again, its Agent resuming its session; one whose PTY ran on
 * rejoins its status and gets its screen from the Host, which it missed
 * while away. Nothing to do for a Workspace with no live panes.
 */
export async function recoverJoinedWorkspace(
	workspaceId: string,
	hostId: string,
	api: {
		alive: (ptyIds: string[]) => Promise<string[]>;
		resync: (ptyIds: string[]) => Promise<unknown>;
		/** Only these PTYs: the ones the Window had when the Host went away. */
		only?: ReadonlySet<string>;
	},
): Promise<{ restarted: number; resynced: number }> {
	const panes = collectLivePanes(workspaceId).filter(
		(p) => !api.only || api.only.has(p.ptyId),
	);
	if (panes.length === 0) return { restarted: 0, resynced: 0 };
	const ids = panes.map((p) => p.ptyId);
	// Unsure: treat every pane as alive (a resync costs nothing).
	const alive = new Set(await api.alive(ids).catch(() => ids));
	let restarted = 0;
	for (const pane of panes.filter((p) => !alive.has(p.ptyId))) {
		try {
			await restartLivePane(pane);
			restarted++;
		} catch (e) {
			console.warn(`[joined] cannot restart ${pane.paneId} on ${hostId}`, e);
		}
	}
	const live = panes.filter((p) => alive.has(p.ptyId)).map((p) => p.ptyId);
	if (live.length > 0) {
		const act = usePtyActivityStore.getState();
		for (const id of live) act.initPty(id);
		await api.resync(live).catch(() => {});
	}
	return { restarted, resynced: live.length };
}

export type RestartAgentResult = "restarted" | "no-pty" | "failed";

/**
 * **Restart agent** from the **Agent menu**: kill one pane's PTY and relaunch
 * its Agent, resuming its session (ADR-0050), the same way an Environment
 * Bundle change restarts a Workspace. Reports what happened, so a confirmed
 * restart that could not run is never silent.
 */
export async function restartAgentPane(
	paneId: string,
): Promise<RestartAgentResult> {
	const store = useWorkspaceStore.getState();
	const workspace = store.findWorkspaceForPane(paneId);
	const pane =
		workspace &&
		collectLivePanes(workspace.id).find((p) => p.paneId === paneId);
	if (!workspace || !pane) return "no-pty";
	try {
		await restartLivePane(pane);
		return "restarted";
	} catch (err) {
		console.warn("[restartAgentPane] restart failed", err);
		return "failed";
	}
}

/**
 * **Restart agent** for a **New task**: respawn one pane's PTY with the Task's
 * Agent. A fresh shell (not a resumed session), in the pane's live folder when
 * known, else the Workspace's. An unmounted pane takes the cold-start path, as
 * `restartWorkspacePtys` does.
 */
export async function restartPaneWithTask(
	paneId: string,
	task: PendingTask,
): Promise<void> {
	const act = usePtyActivityStore.getState();
	const ptyId = act.panePtyMap[paneId];
	const store = useWorkspaceStore.getState();
	const workspace = store.findWorkspaceForPane(paneId);
	const cwd = (ptyId && act.cwds[ptyId]) || workspace?.rootFolder || ".";
	store.stampAgentOnPane(paneId, task.agentId);
	if (livePtyIdByPane()[paneId] !== undefined) {
		await restartPanePty(paneId, { cwd, task, preserveScrollback: false });
		return;
	}
	const tab = workspace?.tabs.find((t) => {
		const layout = parseTabLayout(t.layoutJson);
		return layout ? containsPane(layout, paneId) : false;
	});
	restartUnmountedPane(
		{ paneId, ptyId: ptyId ?? "", tabId: tab?.id ?? "" },
		undefined,
	);
	setPendingTask(paneId, task);
}

/**
 * Restart from a **Watch offer**: respawn one pane's PTY and start its Agent
 * afresh, so it reads the hooks just written. Never a resume: with no hooks
 * until now there is no session id to resume by. In the pane's live folder
 * when known, else the Workspace's; the scrollback stays.
 */
export async function restartPaneWithAgent(
	paneId: string,
	agentId: string,
	command: string,
): Promise<void> {
	const act = usePtyActivityStore.getState();
	const ptyId = act.panePtyMap[paneId];
	const store = useWorkspaceStore.getState();
	const workspace = store.findWorkspaceForPane(paneId);
	const cwd = (ptyId && act.cwds[ptyId]) || workspace?.rootFolder || ".";
	store.stampAgentOnPane(paneId, agentId);
	if (livePtyIdByPane()[paneId] !== undefined) {
		await restartPanePty(paneId, {
			cwd,
			agentCommand: command,
			preserveScrollback: true,
		});
		return;
	}
	const tab = workspace?.tabs.find((t) => {
		const layout = parseTabLayout(t.layoutJson);
		return layout ? containsPane(layout, paneId) : false;
	});
	restartUnmountedPane(
		{ paneId, ptyId: ptyId ?? "", tabId: tab?.id ?? "" },
		command,
	);
}

/**
 * An unmounted pane has a PTY but no xterm instance. Kill the process and clear
 * the layout's ptyId so the next mount takes the ordinary cold-start path.
 *
 * Deliberately spawns nothing now: reusing cold start is what stops this
 * becoming a second, divergent spawn implementation.
 */
function restartUnmountedPane(
	pane: Pick<LivePane, "paneId" | "ptyId" | "tabId">,
	agentCommand?: string,
): void {
	killUnmountedPanePty(pane.paneId, pane.ptyId);

	const store = useWorkspaceStore.getState();
	const workspace = store.findWorkspaceForPane(pane.paneId);
	const tab = workspace?.tabs.find((t) => t.id === pane.tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	if (tab && layout) {
		void store.updateLayout(tab.id, clearPtyId(layout, pane.paneId));
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

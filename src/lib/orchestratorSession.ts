/**
 * The Window side of the **Orchestrator** (ADR-0057): entering and leaving
 * the Orchestrator view, picking its Agent, and starting it.
 *
 * While the view is on screen the Orchestrator workspace is the **Active
 * workspace**, so its Tab bar, panes, focus and every pane shortcut work as
 * they do in any Workspace. Leaving the view makes the Workspace that was
 * Active before Active again.
 */

import { useOrchestratorStore } from "../stores/orchestratorStore";
import { fallbackProfileId } from "../stores/profileStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { orchestrator as orchestratorApi } from "./ipc";
import {
	launchCommand,
	paneRunsAgent,
	stampOrchestrator,
	startPane,
} from "./orchestrator";
import { findNode, parseTabLayout } from "./paneTree";
import { setPendingAgent } from "./pendingAgentRegistry";
import { countAgentPanesByFolder, relaunchForPane } from "./sessionResume";
import { getTerminal, restartPanePty } from "./terminalManager";
import type { WorkspaceWithTabs } from "./types";
import { isOrchestrator } from "./workspaceKind";

const store = () => useOrchestratorStore.getState();
const workspaces = () => useWorkspaceStore.getState();

/** Puts `ws` into the workspace store if it is not there yet (first ever
 *  ensure), with an active Tab so it renders when switched to. */
function upsertWorkspace(ws: WorkspaceWithTabs): void {
	useWorkspaceStore.setState((s) => {
		const present = s.workspaces.some((w) => w.id === ws.id);
		const first = [...ws.tabs].sort((a, b) => a.position - b.position)[0];
		return {
			workspaces: present
				? s.workspaces.map((w) =>
						w.id === ws.id ? { ...w, rootFolder: ws.rootFolder } : w,
					)
				: [...s.workspaces, ws],
			activeTabByWorkspace:
				s.activeTabByWorkspace[ws.id] || !first
					? s.activeTabByWorkspace
					: { ...s.activeTabByWorkspace, [ws.id]: first.id },
		};
	});
}

function storedWorkspace(id: string): WorkspaceWithTabs | undefined {
	return workspaces().workspaces.find((w) => w.id === id);
}

/**
 * Makes `agentId` the Agent of the Orchestrator's pane and starts it there:
 * stamps the pane (Agent and handle), then either seeds it so it launches on
 * first render, or restarts a live PTY into it. Resumes the folder's last
 * session when it can.
 */
/** `keep`: start it only if the pane does not run it yet. `fresh`: a new
 *  conversation (a new pick). `resume`: start it again, resuming. */
type StartMode = "keep" | "fresh" | "resume";

async function startAgentIn(
	ws: WorkspaceWithTabs,
	agentId: string,
	mode: StartMode,
): Promise<void> {
	const agent = useSettingsStore
		.getState()
		.agents.find((a) => a.id === agentId);
	if (!agent) throw new Error("That agent is not available any more.");
	const target = startPane(ws.tabs);
	if (!target) {
		// Every Tab was closed: open a new one with the Agent in it.
		const tab = await workspaces().createTab(ws.id, agent, undefined, {
			activate: true,
			name: "Orchestrator",
		});
		const layout = parseTabLayout(tab.layoutJson);
		const paneId = layout ? startPane([tab])?.paneId : undefined;
		if (layout && paneId) {
			await workspaces().updateLayout(
				tab.id,
				stampOrchestrator(layout, paneId, agentId),
			);
		}
		return;
	}
	const tab = ws.tabs.find((t) => t.id === target.tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	if (!tab || !layout) return;
	const sameAgent = paneRunsAgent(layout, target.paneId, agentId);
	const stamped = stampOrchestrator(layout, target.paneId, agentId);
	if (stamped !== layout) await workspaces().updateLayout(tab.id, stamped);

	const live = getTerminal(target.paneId);
	// A pane that already runs this Agent is left alone unless asked to start
	// it again: the load seeded its relaunch (Session resume, ADR-0050).
	if (sameAgent && mode !== "resume") return;
	// A newly picked or changed Agent starts a new conversation: there is
	// none of its own to resume here, and `--continue` with none fails.
	// Otherwise the folder's last conversation is resumed, falling back to a
	// plain start when there is none (`lib/resumeFallback.ts`).
	const node = findNode(stamped, target.paneId);
	const relaunch =
		mode !== "fresh" && node?.type === "terminal"
			? relaunchForPane(
					node,
					ws.rootFolder,
					countAgentPanesByFolder(workspaces().workspaces),
				)
			: undefined;
	const command = relaunch?.command ?? launchCommand(agent);
	if (live?.ptyId) {
		await restartPanePty(target.paneId, {
			cwd: ws.rootFolder,
			agentCommand: command,
			agentFallback: relaunch?.fallback,
			preserveScrollback: true,
		});
	} else {
		setPendingAgent(target.paneId, { command, fallback: relaunch?.fallback });
	}
}

/** Makes the Orchestrator workspace Active, remembering what to go back to. */
function activate(ws: WorkspaceWithTabs): void {
	const current = workspaces().activeWorkspaceId;
	const currentWs = current ? storedWorkspace(current) : undefined;
	if (current !== ws.id) {
		store().set({
			returnWorkspaceId:
				currentWs && !isOrchestrator(currentWs) ? current : null,
		});
		workspaces().setActiveWorkspace(ws.id);
	}
	store().set({ phase: "ready" });
}

let entering: Promise<void> | null = null;

/** The view came on screen (opened, or restored at launch). */
export function enterOrchestratorView(): Promise<void> {
	if (entering) return entering;
	entering = (async () => {
		const profileId = fallbackProfileId();
		store().set({ phase: "loading", error: null });
		try {
			const ensured = await orchestratorApi.ensure(profileId);
			upsertWorkspace(ensured);
			const agentId = await orchestratorApi.agent(profileId);
			const ws = storedWorkspace(ensured.id) ?? ensured;
			store().set({ workspaceId: ws.id, agentId });
			if (!agentId) {
				store().set({ phase: "pick" });
				return;
			}
			await startAgentIn(ws, agentId, "keep");
			// Leaving while we waited: stay out.
			if (!orchestratorViewWanted()) return;
			activate(storedWorkspace(ws.id) ?? ws);
		} catch (e) {
			store().set({
				phase: "error",
				error: e instanceof Error ? e.message : String(e),
			});
		}
	})().finally(() => {
		entering = null;
	});
	return entering;
}

/** The view left the screen: give the Workspace view its Workspace back. */
export function leaveOrchestratorView(): void {
	const { workspaceId, returnWorkspaceId } = store();
	store().set({ phase: "idle", changingAgent: false });
	const active = workspaces().activeWorkspaceId;
	if (!workspaceId || active !== workspaceId) return;
	const opened = usePtyActivityStore.getState().openedWorkspaceIds;
	const back =
		returnWorkspaceId &&
		storedWorkspace(returnWorkspaceId) &&
		opened.has(returnWorkspaceId)
			? returnWorkspaceId
			: (workspaces().workspaces.find(
					(w) => !isOrchestrator(w) && opened.has(w.id),
				)?.id ?? null);
	workspaces().setActiveWorkspace(back);
}

/** The user picked (or changed) the Orchestrator's Agent. */
export async function pickOrchestratorAgent(agentId: string): Promise<void> {
	const profileId = fallbackProfileId();
	const { workspaceId, agentId: before } = store();
	const ws = workspaceId ? storedWorkspace(workspaceId) : undefined;
	if (!ws) return;
	try {
		await orchestratorApi.setAgent(profileId, agentId);
		store().set({ agentId, changingAgent: false });
		if (before !== agentId) await startAgentIn(ws, agentId, "fresh");
		else await startAgentIn(ws, agentId, "keep");
		activate(storedWorkspace(ws.id) ?? ws);
	} catch (e) {
		store().set({
			phase: "error",
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

/** "Start the Orchestrator" after its Agent exited. */
export async function restartOrchestrator(): Promise<void> {
	const { workspaceId, agentId } = store();
	const ws = workspaceId ? storedWorkspace(workspaceId) : undefined;
	if (!ws || !agentId) return;
	await startAgentIn(ws, agentId, "resume");
}

function orchestratorViewWanted(): boolean {
	return useWindowUiStore.getState().orchestratorViewOpen;
}

/** Wires the session to the view: enter when it shows, leave when it goes.
 *  Runs once the Window's Workspaces are loaded, and again for each Profile
 *  (`App.tsx`). Returns the unsubscribe. */
export function installOrchestratorSession(): () => void {
	store().set({ phase: "idle", workspaceId: null, agentId: null });
	if (orchestratorViewWanted()) void enterOrchestratorView();
	return useWindowUiStore.subscribe((s, prev) => {
		if (s.orchestratorViewOpen === prev.orchestratorViewOpen) return;
		if (s.orchestratorViewOpen) void enterOrchestratorView();
		else leaveOrchestratorView();
	});
}

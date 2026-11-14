/**
 * What the Orchestrator view's graph does with an Agent (ADR-0057): peek at
 * it, or ask the Orchestrator about it.
 */

import { useOrchestratorStore } from "../stores/orchestratorStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { firePromptAction } from "./firePromptAction";
import { orchestratorPane } from "./orchestrator";
import { getTerminal } from "./terminalManager";

/** **Peek**: show an Agent's live terminal to the right of the graph (a
 *  single click on it there). Replaces the Agent peeked at before. */
export function peekAgent(paneId: string): void {
	useOrchestratorStore
		.getState()
		.set({ selectedPaneId: paneId, peekPaneId: paneId });
}

/** Close the Peek: the terminal goes back to its Workspace. */
export function closePeek(): void {
	useOrchestratorStore.getState().set({ peekPaneId: null });
}

/** The question "Ask the Orchestrator about it" sends. */
export function askAboutText(handle: string, workspaceName: string): string {
	return `What is ${handle} in ${workspaceName} doing right now, and does it need me? Answer in two or three plain sentences.`;
}

export type AskResult = "sent" | "typed" | "not-running" | "waiting";

/**
 * Sends a question about an Agent to the Orchestrator. While the
 * Orchestrator is Working it is typed but not sent, so it does not cut into
 * the turn; while it is Waiting nothing is sent (a permission prompt reads
 * keys differently, see `canFire`).
 */
export function askOrchestrator(text: string): AskResult {
	const { workspaceId } = useOrchestratorStore.getState();
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	const pane = ws ? orchestratorPane(ws.tabs) : null;
	const ptyId = pane ? getTerminal(pane.paneId)?.ptyId : undefined;
	if (!pane || !ptyId) return "not-running";
	const state = usePtyActivityStore.getState().activities[ptyId]?.state;
	const working = state === "active";
	const result = firePromptAction(
		pane.paneId,
		text,
		{},
		{},
		{
			stageOnly: working,
		},
	);
	if (!result.ok)
		return result.reason === "waiting" ? "waiting" : "not-running";
	return working ? "typed" : "sent";
}

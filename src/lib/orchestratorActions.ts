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
	const { peekFocused } = useOrchestratorStore.getState();
	useOrchestratorStore
		.getState()
		.set({ selectedPaneId: paneId, peekPaneId: paneId });
	// Focus follows the Peek: a click on another Agent in the graph, while
	// the Peek had the keyboard, gives that Agent's terminal the keyboard.
	if (peekFocused) focusWhenPlaced(paneId, "[data-peek-pane]");
}

/** Close the Peek: the terminal goes back to its Workspace. */
export function closePeek(): void {
	useOrchestratorStore.getState().set({ peekPaneId: null, peekFocused: false });
}

/** The Peek takes keyboard focus (a click into it, a prompt action fired at
 *  it, the Agent cycle). A file Orchestrator tab gives it up. */
export function focusPeek(): void {
	useOrchestratorStore
		.getState()
		.set({ peekFocused: true, fileTabFocused: false });
}

/**
 * Gives `paneId`'s terminal the keyboard once it is where it is going.
 * Moving a terminal into the Peek drops its focus, and the move hides it
 * until it has painted (ADR-0040): a browser ignores `focus()` on a hidden
 * element. So keep trying, frame by frame, until focus is really inside it
 * (`within`: the container it must sit in, or anywhere when null).
 */
export function focusWhenPlaced(paneId: string, within: string | null): void {
	let frames = 0;
	const tick = () => {
		const term = getTerminal(paneId)?.term;
		const el = term?.element;
		if (term && el?.isConnected && (!within || el.closest(within))) {
			term.focus();
			if (el.contains(document.activeElement)) return;
		}
		if (++frames < 90) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

/** Close the Peek and put keyboard focus back in the Orchestrator's own pane
 *  (the Agent cycle landing on the Orchestrator; Close pane in the Peek). */
export function closePeekToOrchestrator(): void {
	closePeek();
	const { workspaceId } = useOrchestratorStore.getState();
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	const own = ws ? orchestratorPane(ws.tabs) : null;
	if (!ws || !own) return;
	const store = useWorkspaceStore.getState();
	store.setActiveTab(ws.id, own.tabId);
	store.setFocusedPane(own.paneId);
	focusWhenPlaced(own.paneId, null);
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

/**
 * The **Agent cycle** in the **Orchestrator view** (GLOSSARY.md): it moves
 * the **Peek** through the graph's own order and never leaves the view. The
 * Orchestrator itself is the stop before the first Agent: landing there
 * closes the Peek and gives its pane the keyboard back.
 */

import { useOrchestratorStore } from "../stores/orchestratorStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { orchestratorViewShowing } from "./fleetFocus";
import { orchestratorPane } from "./orchestrator";
import { closePeek, peekAgent } from "./orchestratorActions";
import { type GraphModel, graphModel } from "./orchestratorGraph";
import { selectOrchestratorTab } from "./orchestratorTabs";
import { getTerminal } from "./terminalManager";
import { buildWorkspaceRows, flattenRowsToIds } from "./worktreeGrouping";

/** The Agents in the graph's order: Workspaces top to bottom, Agents left
 *  to right inside each, then the Orchestrator's helpers. Pure. */
export function graphCycleOrder(model: GraphModel): string[] {
	return [
		...model.workspaces.flatMap((w) => w.agents.map((a) => a.paneId)),
		...model.helpers.map((h) => h.paneId),
	];
}

/**
 * The next stop from `peek` (the Agent peeked at, or `null` for the
 * Orchestrator): an Agent's pane id, or `null` for the Orchestrator. Wraps;
 * a Peek no longer in the order counts as the Orchestrator. Pure.
 */
export function nextPeekStop(
	order: readonly string[],
	peek: string | null,
	step: 1 | -1,
): string | null {
	const stops: (string | null)[] = [null, ...order];
	const at = peek ? Math.max(0, stops.indexOf(peek)) : 0;
	return stops[(at + step + stops.length) % stops.length];
}

/** Whether the Orchestrator view is on screen with its graph ready, so the
 *  Agent cycle moves the Peek there. */
export function orchestratorCycleApplies(): boolean {
	return (
		orchestratorViewShowing() &&
		useOrchestratorStore.getState().phase === "ready"
	);
}

/** The graph's model now, as the graph draws it. */
function currentModel(): GraphModel {
	const { workspaces } = useWorkspaceStore.getState();
	const { openedWorkspaceIds, panePtyMap, activities } =
		usePtyActivityStore.getState();
	const facts = useWorkspaceGitStore.getState().worktreeFacts;
	const orchWs = workspaces.find(
		(w) => w.id === useOrchestratorStore.getState().workspaceId,
	);
	return graphModel({
		workspaces,
		order: flattenRowsToIds(buildWorkspaceRows(workspaces, facts)),
		openedWorkspaceIds,
		panePtyMap,
		isAgentPty: (p) => activities[p]?.detectionMode === "agent",
		orchestratorPaneId: orchWs
			? (orchestratorPane(orchWs.tabs)?.paneId ?? null)
			: null,
	});
}

/**
 * Gives `paneId`'s terminal the keyboard once it is where it is going.
 * Moving a terminal into the Peek drops its focus, and the move hides it
 * until it has painted (ADR-0040): a browser ignores `focus()` on a hidden
 * element. So keep trying, frame by frame, until focus is really inside it
 * (`within`: the container it must sit in, or anywhere when null).
 */
function focusWhenPlaced(paneId: string, within: string | null): void {
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

/** Runs the Agent cycle in the Orchestrator view. */
export function cycleOrchestrator(step: 1 | -1): void {
	const orch = useOrchestratorStore.getState();
	// The Peek sits beside the graph: bring the graph to the front.
	if (orch.selectedTabId !== null) selectOrchestratorTab(null);
	const stop = nextPeekStop(
		graphCycleOrder(currentModel()),
		orch.peekPaneId,
		step,
	);
	if (stop) {
		peekAgent(stop);
		orch.set({ peekFocusTick: orch.peekFocusTick + 1 });
		focusWhenPlaced(stop, "[data-peek-pane]");
		return;
	}
	closePeek();
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === orch.workspaceId);
	const own = ws ? orchestratorPane(ws.tabs) : null;
	if (!ws || !own) return;
	const store = useWorkspaceStore.getState();
	store.setActiveTab(ws.id, own.tabId);
	store.setFocusedPane(own.paneId);
	focusWhenPlaced(own.paneId, null);
}

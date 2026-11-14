// The **Agent cycle**: next / previous Agent in **Handle order**, wrapping.

import { useWorkspaceStore } from "../stores/workspaceStore";
import { agentsInHandleOrderNow } from "./agentPanes";
import { cycleTile, type FleetTile } from "./fleetConsole";
import { cycleFleet, fleetConsoleShowing } from "./fleetFocus";
import { switchToPane } from "./paneLocation";

/**
 * The Agent to go to from the Workspace view. Starts from the Focused pane
 * when it is an Agent in the Workspace being shown (`focusedPaneId` can still
 * name a pane of another Workspace); otherwise next is the first Agent and
 * previous the last. Pure.
 */
export function nextAgentPane(
	agents: readonly FleetTile[],
	focusedPaneId: string | null,
	shownWorkspaceId: string | null,
	step: 1 | -1,
): string | null {
	const current = agents.find(
		(t) => t.paneId === focusedPaneId && t.workspaceId === shownWorkspaceId,
	);
	return cycleTile(agents, current?.paneId ?? null, step);
}

/** Run the Agent cycle. In the Fleet Console it moves the **Focused tile** in
 *  the Console's own order and stays there; elsewhere it is a **Switch to**. */
export function cycleAgent(step: 1 | -1): void {
	if (fleetConsoleShowing()) {
		cycleFleet(step);
		return;
	}
	const ws = useWorkspaceStore.getState();
	const target = nextAgentPane(
		agentsInHandleOrderNow(),
		ws.focusedPaneId,
		// A switch still in flight: step from it, so a held key keeps advancing.
		ws.switchingWorkspaceId ?? ws.activeWorkspaceId,
		step,
	);
	if (target) switchToPane(target);
}

// Every agent-mode pane of the Window's Opened workspaces: the **Fleet
// Console**'s tiles, the **Agents list**'s rows and the **Agent cycle**'s
// stops. One input builder serves the React hook (`useAgentPanes`) and the
// imperative path, so they always agree on which Agents exist.

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { handleForPane } from "./agentHandle";
import {
	type FleetTile,
	type FleetTilesInput,
	fleetTiles,
} from "./fleetConsole";
import { sortByHandle } from "./handleOrder";
import type { WorkspaceWithTabs } from "./types";
import { buildWorkspaceRows, flattenRowsToIds } from "./worktreeGrouping";

export interface AgentPanesSource
	extends Omit<FleetTilesInput, "sidebarOrder"> {
	worktreeFacts: Parameters<typeof buildWorkspaceRows>[1];
}

/** The agent-mode panes in **derived order**, from plain store values. */
export function agentPanesFrom({
	worktreeFacts,
	...rest
}: AgentPanesSource): FleetTile[] {
	return fleetTiles({
		...rest,
		sidebarOrder: flattenRowsToIds(
			buildWorkspaceRows(rest.workspaces, worktreeFacts),
		),
	});
}

/** The tiles in **Handle order**: the Agents list and the Agent cycle. */
export function inHandleOrder(
	tiles: readonly FleetTile[],
	workspaces: readonly WorkspaceWithTabs[],
): FleetTile[] {
	return sortByHandle(tiles, (t) => handleForPane(workspaces, t.paneId));
}

/** The Agents list's rows right now, outside React (the Agent cycle). */
export function agentsInHandleOrderNow(): FleetTile[] {
	const { workspaces } = useWorkspaceStore.getState();
	const act = usePtyActivityStore.getState();
	const tiles = agentPanesFrom({
		workspaces,
		worktreeFacts: useWorkspaceGitStore.getState().worktreeFacts,
		openedWorkspaceIds: act.openedWorkspaceIds,
		activities: act.activities,
		panePtyMap: act.panePtyMap,
	});
	return inHandleOrder(tiles, workspaces);
}

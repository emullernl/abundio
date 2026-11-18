// Every agent-mode pane of the Window's Opened workspaces: the **Fleet
// Console**'s tiles, the **Agents list**'s rows and the **Agent cycle**'s
// stops. One input builder serves the React hook (`useAgentPanes`) and the
// imperative path, so they always agree on which Agents exist.

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
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

/** One group of a grouped **Agents list**: a Workspace and its Agents. */
export interface AgentGroup {
	workspaceId: string;
	tiles: FleetTile[];
}

/**
 * The tiles grouped by Workspace, groups in the tiles' own (Left sidebar)
 * order, Agents in **Handle order** inside each. Workspaces with no Agent
 * have no group; each Linked worktree is its own Workspace, so its own group.
 */
export function groupByWorkspace(
	tiles: readonly FleetTile[],
	workspaces: readonly WorkspaceWithTabs[],
): AgentGroup[] {
	const groups = new Map<string, FleetTile[]>();
	for (const t of tiles) {
		const g = groups.get(t.workspaceId);
		if (g) g.push(t);
		else groups.set(t.workspaceId, [t]);
	}
	return [...groups].map(([workspaceId, g]) => ({
		workspaceId,
		tiles: inHandleOrder(g, workspaces),
	}));
}

/** The Agents list's rows top to bottom as drawn: grouped or flat. */
export function inListOrder(
	tiles: readonly FleetTile[],
	workspaces: readonly WorkspaceWithTabs[],
	grouped: boolean,
): FleetTile[] {
	return grouped
		? groupByWorkspace(tiles, workspaces).flatMap((g) => g.tiles)
		: inHandleOrder(tiles, workspaces);
}

/** The Agents list's rows right now, outside React (the Agent cycle). */
export function agentsInListOrderNow(): FleetTile[] {
	const { workspaces } = useWorkspaceStore.getState();
	const act = usePtyActivityStore.getState();
	const tiles = agentPanesFrom({
		workspaces,
		worktreeFacts: useWorkspaceGitStore.getState().worktreeFacts,
		openedWorkspaceIds: act.openedWorkspaceIds,
		activities: act.activities,
		panePtyMap: act.panePtyMap,
	});
	return inListOrder(
		tiles,
		workspaces,
		useSettingsStore.getState().agentsListGrouped,
	);
}

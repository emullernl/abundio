import { useMemo } from "react";
import {
	agentPanesFrom,
	groupByWorkspace,
	inHandleOrder,
} from "../lib/agentPanes";
import type { FleetTile } from "../lib/fleetConsole";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

type PtyActivities = ReturnType<
	typeof usePtyActivityStore.getState
>["activities"];

/** Stable empty set, so `includePending: false` never changes identity. */
const NO_PENDING: ReadonlySet<string> = new Set();

let lastActivities: PtyActivities | null = null;
let lastKey = "";

/**
 * A stable key of the agent-mode ptyIds. The store's selectors run on
 * *every* store update (titles, cwds, running commands…), but `activities`
 * is only replaced when a status changes, so the key is recomputed only for
 * a new `activities` object. One cache serves every caller, since they all
 * read the same store. Exported for tests.
 */
export function agentModeKey(activities: PtyActivities): string {
	if (activities !== lastActivities) {
		lastActivities = activities;
		lastKey = Object.keys(activities)
			.filter((id) => activities[id]?.detectionMode === "agent")
			.sort()
			.join("|");
	}
	return lastKey;
}

/**
 * Every agent-mode pane of this Window's Opened workspaces, in **derived
 * order** — the **Fleet Console**'s tiles and the **Agents list**'s rows.
 *
 * `includePending` adds the Console's pending tiles: an Agent just started
 * from the Console needs its tile before it reaches agent mode. The Agents
 * list leaves them out, because such a pane is not running an Agent yet.
 */
export function useAgentPanes({
	includePending,
}: {
	includePending: boolean;
}): FleetTile[] {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	// Membership only changes with detection mode, so select a stable key of
	// the agent-mode ptyIds rather than the whole (hot) activities map.
	const agentKey = usePtyActivityStore((s) => agentModeKey(s.activities));
	const pendingTiles = useWindowUiStore((s) =>
		includePending ? s.pendingTiles : undefined,
	);
	return useMemo(() => {
		void agentKey;
		return agentPanesFrom({
			alsoShow: pendingTiles ? new Set(Object.keys(pendingTiles)) : NO_PENDING,
			workspaces,
			worktreeFacts,
			openedWorkspaceIds,
			activities: usePtyActivityStore.getState().activities,
			panePtyMap,
		});
	}, [
		workspaces,
		worktreeFacts,
		openedWorkspaceIds,
		panePtyMap,
		agentKey,
		pendingTiles,
	]);
}

/** The **Agents list**'s rows: one group per Workspace when grouped, else a
 *  single group (`workspaceId: null`) of every Agent in **Handle order**. */
export function useAgentsListGroups(): {
	grouped: boolean;
	groups: { workspaceId: string | null; tiles: FleetTile[] }[];
	count: number;
} {
	const tiles = useAgentPanes({ includePending: false });
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const grouped = useSettingsStore((s) => s.agentsListGrouped);
	return useMemo(() => {
		const groups: { workspaceId: string | null; tiles: FleetTile[] }[] = grouped
			? groupByWorkspace(tiles, workspaces)
			: [{ workspaceId: null, tiles: inHandleOrder(tiles, workspaces) }];
		return { grouped, groups, count: tiles.length };
	}, [tiles, workspaces, grouped]);
}

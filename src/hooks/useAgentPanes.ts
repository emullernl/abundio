import { useMemo } from "react";
import { type FleetTile, fleetTiles } from "../lib/fleetConsole";
import { buildWorkspaceRows, flattenRowsToIds } from "../lib/worktreeGrouping";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** Stable empty set, so `includePending: false` never changes identity. */
const NO_PENDING: ReadonlySet<string> = new Set();

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
	const agentKey = usePtyActivityStore((s) =>
		Object.keys(s.activities)
			.filter((id) => s.activities[id]?.detectionMode === "agent")
			.sort()
			.join("|"),
	);
	const pendingTiles = useWindowUiStore((s) =>
		includePending ? s.pendingTiles : undefined,
	);
	return useMemo(() => {
		void agentKey;
		return fleetTiles({
			alsoShow: pendingTiles ? new Set(Object.keys(pendingTiles)) : NO_PENDING,
			workspaces,
			sidebarOrder: flattenRowsToIds(
				buildWorkspaceRows(workspaces, worktreeFacts),
			),
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

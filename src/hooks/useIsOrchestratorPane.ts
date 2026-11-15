import { useMemo } from "react";
import { isOrchestratorPane } from "../lib/orchestrator";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** Whether the pane is the **Orchestrator**'s own (ADR-0057): its prompt
 *  actions are the Orchestrator's only. Its helpers' panes are not. */
export function useIsOrchestratorPane(paneId: string): boolean {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	return useMemo(
		() => isOrchestratorPane(workspaces, paneId),
		[workspaces, paneId],
	);
}

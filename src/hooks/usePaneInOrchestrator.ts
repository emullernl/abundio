import { useMemo } from "react";
import { paneInOrchestrator } from "../lib/orchestrator";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** Whether the pane belongs to the Orchestrator workspace (ADR-0057). */
export function usePaneInOrchestrator(paneId: string): boolean {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	return useMemo(
		() => paneInOrchestrator(workspaces, paneId),
		[workspaces, paneId],
	);
}

import { handleForPane } from "../lib/agentHandle";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** The **Agent handle** of a pane, or undefined. */
export function useAgentHandle(paneId: string): string | undefined {
	return useWorkspaceStore((s) => handleForPane(s.workspaces, paneId));
}

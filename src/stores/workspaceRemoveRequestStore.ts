import { create } from "zustand";

/**
 * Asks the **Left sidebar** to run its Remove Workspace confirm for a
 * Workspace, from somewhere else in the Window (the Missing folder panel).
 * The sidebar owns that confirm because it also offers the Linked worktrees
 * of a Primary, so there is one dialog, not two that can drift.
 */
interface WorkspaceRemoveRequestState {
	requestedId: string | null;
	requestRemove: (workspaceId: string) => void;
	clear: () => void;
}

export const useWorkspaceRemoveRequestStore =
	create<WorkspaceRemoveRequestState>()((set) => ({
		requestedId: null,
		requestRemove: (requestedId) => set({ requestedId }),
		clear: () => set({ requestedId: null }),
	}));

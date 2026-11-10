import { useEffect } from "react";
import { addWindowFocusListener } from "../lib/windowFocus";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Re-check **Missing folder**s (ADR-0053) whenever this Window gets focus,
 * which is when someone who just plugged in a drive comes back to the app.
 * The first check runs as part of `loadWorkspaces`.
 */
export function useMissingFolderRefresh(): void {
	useEffect(
		() =>
			addWindowFocusListener((focused) => {
				if (!focused) return;
				if (!useWorkspaceStore.getState().workspacesInitialized) return;
				void useWorkspaceStore.getState().refreshMissingFolders();
			}),
		[],
	);
}

import { useEffect } from "react";
import { restoreFileTabs } from "../stores/explorerStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function useWorkspace() {
	const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);

	useEffect(() => {
		loadWorkspaces().then(() => {
			const workspaces = useWorkspaceStore.getState().workspaces;
			restoreFileTabs(workspaces);
		});
	}, [loadWorkspaces]);
}

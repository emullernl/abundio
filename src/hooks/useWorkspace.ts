import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function useWorkspace() {
	const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);

	useEffect(() => {
		loadWorkspaces();
	}, [loadWorkspaces]);
}

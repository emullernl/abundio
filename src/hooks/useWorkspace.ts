import { useEffect } from "react";
import { useProfileStore } from "../stores/profileStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function useWorkspace() {
	const loadProfiles = useProfileStore((s) => s.loadProfiles);
	const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);

	useEffect(() => {
		// Load profiles first so workspaceStore.loadWorkspaces sees the active
		// profile id (reconciled against the persisted value).
		(async () => {
			await loadProfiles();
			await loadWorkspaces();
		})();
	}, [loadProfiles, loadWorkspaces]);
}

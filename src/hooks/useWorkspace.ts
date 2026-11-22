import { useEffect } from "react";
import { hostsApi } from "../lib/ipc";
import { copyHostPromptActionsOnce } from "../lib/promptActionsCopy";
import { useHostAgentsStore } from "../stores/hostAgentsStore";
import { useJoinedStore } from "../stores/joinedStore";
import { useProfileStore } from "../stores/profileStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** Load the Window's Profiles, then its Workspaces. Profiles come first so
 *  workspaceStore.loadWorkspaces sees the active profile id (reconciled
 *  against the persisted value). A remote Window whose Host is not
 *  connected has nothing to load yet: it shows empty, with its "Sign in
 *  needed" banner, instead of the loading screen, and reloads once the
 *  Host connects. */
export async function loadWindow(): Promise<void> {
	await useProfileStore.getState().loadProfiles();
	if (useProfileStore.getState().remoteError) {
		useWorkspaceStore.setState({ workspacesInitialized: true });
		return;
	}
	await useWorkspaceStore.getState().loadWorkspaces();
	// A remote Window's Agents are its Host's (Host settings, ADR-0064).
	const remote = useProfileStore.getState().remote;
	if (remote) {
		void useHostAgentsStore.getState().load(remote.hostId);
		// Opened to show its Orchestrator (a joined section's menu, 10e).
		void enterRequestedView();
		// Its Prompt actions were the Host's until now: copied here once.
		void copyHostPromptActionsOnce(remote.hostId).catch(() => {});
	}
	// The Joined profiles connect in the background (phase 10).
	void useJoinedStore.getState().loadJoined();
}

export function useWorkspace() {
	useEffect(() => {
		void loadWindow();
	}, []);
}

/** Enter the view this remote Window was opened for, if any (phase 10e:
 *  "Open Orchestrator" from a joined section). */
export async function enterRequestedView(): Promise<void> {
	const view = await hostsApi.takeView().catch(() => null);
	if (view !== "orchestrator") return;
	const { enterOrchestratorView } = await import("../lib/orchestratorSession");
	await enterOrchestratorView();
}

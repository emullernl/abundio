import { beforeEach, describe, expect, it, vi } from "vitest";
import { useJoinedStore } from "../../stores/joinedStore";
import { useProfileStore } from "../../stores/profileStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { loadWindow } from "../useWorkspace";

describe("loadWindow", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({ workspacesInitialized: false });
		// Joined profiles load in the background; not what these tests are
		// about, and they would reach for the Host list.
		useJoinedStore.setState({ loadJoined: async () => {} });
	});

	it("shows a remote Window whose Host is not connected instead of loading forever", async () => {
		const loadWorkspaces = vi.fn(async () => {
			throw new Error("not connected");
		});
		useWorkspaceStore.setState({ loadWorkspaces });
		useProfileStore.setState({
			loadProfiles: async () => {
				useProfileStore.setState({ remoteError: "not connected" });
			},
		});
		await loadWindow();
		expect(useWorkspaceStore.getState().workspacesInitialized).toBe(true);
		expect(loadWorkspaces).not.toHaveBeenCalled();
	});

	it("loads Workspaces otherwise", async () => {
		const loadWorkspaces = vi.fn(async () => {});
		useWorkspaceStore.setState({ loadWorkspaces });
		useProfileStore.setState({
			remoteError: null,
			loadProfiles: async () => {},
		});
		await loadWindow();
		expect(loadWorkspaces).toHaveBeenCalled();
	});
});

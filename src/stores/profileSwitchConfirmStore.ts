import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { appWindow } from "../lib/appWindow";
import { useProfileStore } from "./profileStore";
import { usePtyActivityStore } from "./ptyActivityStore";

interface PendingSwitch {
	targetProfileId: string;
	targetProfileName: string;
	openedWorkspaceCount: number;
}

interface ProfileSwitchConfirmState {
	pending: PendingSwitch | null;
}

export const useProfileSwitchConfirmStore = create<ProfileSwitchConfirmState>(
	() => ({
		pending: null,
	}),
);

/** Top-level entry point for any UI surface (command palette, settings panel,
 *  etc.) that wants to switch profile.
 *
 *  Behavior, in priority order:
 *  - Target equals THIS window's active profile → no-op.
 *  - Target is open in ANOTHER window → focus that window (don't switch here).
 *    Matches the File menu "Switch Profile" behavior in lib.rs.
 *  - Target is unowned → if THIS window has Opened workspaces, raise the
 *    confirm dialog; otherwise switch immediately. */
export async function requestSwitchProfile(targetId: string): Promise<void> {
	const profileStore = useProfileStore.getState();
	if (targetId === profileStore.activeProfileId) return;

	const target = profileStore.profiles.find((p) => p.id === targetId);
	if (!target) return;

	// If the profile is already open in some other window, focus it instead
	// of switching THIS window's profile (which would create a conflicting
	// ownership state).
	const ownerLabel = profileStore.ownershipMap[targetId];
	// `null` outside Tauri — skip the focus path.
	const thisWindowLabel = appWindow()?.label ?? null;
	if (ownerLabel && thisWindowLabel && ownerLabel !== thisWindowLabel) {
		await invoke("focus_window", { label: ownerLabel }).catch(() => {});
		return;
	}

	const openedWorkspaceCount =
		usePtyActivityStore.getState().openedWorkspaceIds.size;

	if (openedWorkspaceCount === 0) {
		// No agents/PTYs to lose — switch immediately.
		await profileStore.switchProfile(targetId);
		return;
	}

	useProfileSwitchConfirmStore.setState({
		pending: {
			targetProfileId: targetId,
			targetProfileName: target.name,
			openedWorkspaceCount,
		},
	});
}

export async function confirmProfileSwitch(): Promise<void> {
	const pending = useProfileSwitchConfirmStore.getState().pending;
	useProfileSwitchConfirmStore.setState({ pending: null });
	if (!pending) return;
	await useProfileStore.getState().switchProfile(pending.targetProfileId);
}

export function cancelProfileSwitch(): void {
	useProfileSwitchConfirmStore.setState({ pending: null });
}

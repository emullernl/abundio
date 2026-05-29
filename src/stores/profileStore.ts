import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { profiles as profilesApi } from "../lib/ipc";
import type { Profile } from "../lib/types";
import { DEFAULT_PROFILE_ID } from "../lib/types";
// Static cycle with workspaceStore / ptyActivityStore: both import
// `fallbackProfileId` / `currentNotificationTitle` from this module, and we
// import their stores here. ES-module live bindings make the cycle benign
// because all cross-store references are used inside function bodies, never
// at module top-level — by the time `switchProfile` runs, every module has
// finished initializing. Previously these were dynamic imports for that
// reason, but they triggered Rolldown's INEFFECTIVE_DYNAMIC_IMPORT warning
// (the modules are statically imported elsewhere, so the dynamic version
// wasn't actually splitting any chunks).
import { usePtyActivityStore } from "./ptyActivityStore";
import { useWorkspaceStore } from "./workspaceStore";

/** Window-title format — must match `window_title_for` on the Rust side
 *  (window_management.rs). Also used as the notification title (see
 *  `currentNotificationTitle`) so the OS-level identification of any Abundio
 *  notification carries the same profile context as the window it came from. */
export function profileQualifiedTitle(profileName: string): string {
	return `Abundio - ${profileName} profile`;
}

function applyWindowTitle(profileName: string | null): void {
	if (!profileName) return;
	// Guard against running outside Tauri (e.g. jsdom unit tests where
	// `getCurrentWindow()` returns undefined because there's no webview).
	try {
		const w = getCurrentWindow();
		w?.setTitle?.(profileQualifiedTitle(profileName))?.catch?.(() => {});
	} catch {
		// no-op
	}
}

/** Returns the notification-bar title to use for this Window's notifications.
 *  Falls back to plain "Abundio" only when the profile name isn't resolvable
 *  yet (very early startup before profiles loaded). */
export function currentNotificationTitle(): string {
	const state = useProfileStore.getState();
	const active = state.profiles.find((p) => p.id === state.activeProfileId);
	return active ? profileQualifiedTitle(active.name) : "Abundio";
}

interface ProfileState {
	profiles: Profile[];
	activeProfileId: string | null;
	profilesLoaded: boolean;
	/** profileId → windowLabel for every Profile currently owned by some
	 *  Window in this app process. The current window's profile is also in
	 *  this map (mapped to its own label). Refreshed on the
	 *  `profile-ownership-changed` Tauri event. */
	ownershipMap: Record<string, string>;

	loadProfiles: () => Promise<void>;
	/** Pulls the latest profile list from Rust and re-applies this window's
	 *  title from the (possibly renamed) active profile's name. Called from
	 *  every root on the `profiles-changed` Tauri event so a rename in one
	 *  window updates the title chrome of the window that owns the profile. */
	refreshProfiles: () => Promise<void>;
	createProfile: (name: string) => Promise<Profile>;
	renameProfile: (id: string, name: string) => Promise<void>;
	deleteProfile: (id: string) => Promise<void>;
	reorderProfiles: (ids: string[]) => Promise<void>;

	/** Refresh the ownership map from Rust. Called on startup and on every
	 *  `profile-ownership-changed` event. */
	refreshOwnershipMap: () => Promise<void>;

	/** Set the active profile id locally and notify Rust for native-menu sync.
	 *  Does NOT trigger workspace reloading or close-opened-workspaces — that
	 *  is the responsibility of the caller (see switchProfile). */
	setActiveProfileIdLocal: (id: string | null) => Promise<void>;

	/** Unconditionally switches *this window* to the given profile: closes any
	 *  opened workspaces, swaps activeProfileId, reloads workspaces. Callers
	 *  should show a confirm dialog first when Opened workspaces exist — see
	 *  requestSwitchProfile. */
	switchProfile: (id: string) => Promise<void>;

	getActiveProfile: () => Profile | undefined;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
	profiles: [],
	activeProfileId: null,
	profilesLoaded: false,
	ownershipMap: {},

	loadProfiles: async () => {
		const list = await profilesApi.list();
		set({ profiles: list, profilesLoaded: true });

		// The Rust side seeds this window's profile during app setup (from
		// windows.json or the first-profile fallback). Pull it down so this
		// frontend store reflects the canonical value.
		const fromRust = await profilesApi
			.getActiveProfileForWindow()
			.catch(() => null);

		// Reconcile: if Rust has an id for us, use it; otherwise fall back to
		// the first unowned profile and push it back to Rust.
		const ownership = await profilesApi.getOwnershipMap().catch(() => ({}));
		set({ ownershipMap: ownership });

		let next: string | null = fromRust;
		const valid = next && list.some((p) => p.id === next);
		if (!valid) {
			// Either the Rust seed pointed at a profile that no longer exists,
			// or there was no seed. Pick the first profile not owned by another
			// window. Exclude our own window's entry from the "owned" set since
			// any id we hold here is the stale value we're about to overwrite.
			let ownLabel: string | null = null;
			try {
				ownLabel = getCurrentWindow().label;
			} catch {
				// jsdom / outside Tauri — no label to exclude.
			}
			const ownedByOthers = new Set(
				Object.entries(ownership)
					.filter(([_pid, label]) => label !== ownLabel)
					.map(([pid]) => pid),
			);
			next =
				list.find((p) => !ownedByOthers.has(p.id))?.id ?? list[0]?.id ?? null;
		}

		set({ activeProfileId: next });
		await profilesApi.setActiveProfileId(next).catch(() => {});

		// Sync the window title to the active profile's name. The Rust side
		// already set this at spawn time; we re-apply here for two reasons:
		// (a) the main window is spawned by tauri.conf.json with a static
		// title BEFORE this loadProfiles call resolves, so it may still show
		// the conf title on first paint; (b) frontend-driven renames need
		// the frontend to be the source of truth.
		const activeProfile = list.find((p) => p.id === next);
		applyWindowTitle(activeProfile?.name ?? null);
	},

	refreshProfiles: async () => {
		const list = await profilesApi.list().catch(() => null);
		if (!list) return;
		set({ profiles: list });
		const activeId = get().activeProfileId;
		const active = list.find((p) => p.id === activeId);
		applyWindowTitle(active?.name ?? null);
	},

	createProfile: async (name: string) => {
		const profile = await profilesApi.create(name);
		set((s) => ({ profiles: [...s.profiles, profile] }));
		return profile;
	},

	renameProfile: async (id, name) => {
		await profilesApi.update(id, { name });
		set((s) => ({
			profiles: s.profiles.map((p) => (p.id === id ? { ...p, name } : p)),
		}));
		// If the renamed profile is the active one for this window, update
		// the window title immediately.
		if (get().activeProfileId === id) {
			applyWindowTitle(name);
		}
	},

	deleteProfile: async (id) => {
		await profilesApi.delete(id);
		set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) }));
	},

	reorderProfiles: async (ids) => {
		const byId = new Map(get().profiles.map((p) => [p.id, p]));
		const reordered = ids
			.map((id) => byId.get(id))
			.filter((p): p is Profile => p !== undefined);
		set({ profiles: reordered });
		await profilesApi.reorder(ids).catch(() => {});
	},

	refreshOwnershipMap: async () => {
		const ownership = await profilesApi.getOwnershipMap().catch(() => ({}));
		set({ ownershipMap: ownership });
	},

	setActiveProfileIdLocal: async (id) => {
		if (get().activeProfileId === id) return;
		set({ activeProfileId: id });
		await profilesApi.setActiveProfileId(id).catch(() => {});
	},

	switchProfile: async (id: string) => {
		const { activeProfileId } = get();
		if (id === activeProfileId) return;

		const openedIds = Array.from(
			usePtyActivityStore.getState().openedWorkspaceIds,
		);
		const wsStore = useWorkspaceStore.getState();
		for (const wid of openedIds) {
			await wsStore.closeWorkspace(wid).catch(() => {});
		}

		await get().setActiveProfileIdLocal(id);
		await useWorkspaceStore.getState().loadWorkspaces();

		// Re-sync the window title to the new active profile.
		const newActive = get().profiles.find((p) => p.id === id);
		applyWindowTitle(newActive?.name ?? null);
	},

	getActiveProfile: () => {
		const { profiles, activeProfileId } = get();
		return profiles.find((p) => p.id === activeProfileId);
	},
}));

/** Initial fallback profile id used before profilesLoaded — kept for tests
 *  and the brief window-startup gap where workspaceStore may need *some*
 *  profile_id. In production, profileStore.loadProfiles() resolves first. */
export function fallbackProfileId(): string {
	return useProfileStore.getState().activeProfileId ?? DEFAULT_PROFILE_ID;
}

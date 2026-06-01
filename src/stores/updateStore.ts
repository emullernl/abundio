import { create } from "zustand";
import { type UpdateInfo, updates } from "../lib/ipc";
import { useSettingsStore } from "./settingsStore";

/**
 * In-app update lifecycle for the current Window. See ADR-0014.
 *
 * The Rust background loop checks for updates and emits `update-available` to
 * the focused Window; `setAvailable` is the listener sink. The Settings
 * "Check for updates" button drives `check({ manual: true })` directly. Accept
 * → `download` (eager, install-on-quit by default) → optional `installNow`
 * (restart) guarded by a confirm at the call site.
 *
 * One store instance per Window (Zustand is per-JS-context); the prompt and the
 * Settings section both read it within their own Window.
 */
export type UpdateStatus =
	| "idle"
	| "checking"
	| "uptodate"
	| "available"
	| "downloading"
	| "ready"
	| "error";

interface UpdateStoreState {
	status: UpdateStatus;
	info: UpdateInfo | null;
	downloaded: number;
	total: number | null;
	error: string | null;
	/** "Later" dismissal for this session; cleared when a new check finds an update. */
	dismissed: boolean;

	/** Sink for the Rust `update-available` event. Respects the skipped version. */
	setAvailable: (info: UpdateInfo) => void;
	/** Run a check. `manual` surfaces an "up to date" result and ignores skip. */
	check: (opts?: { manual?: boolean }) => Promise<void>;
	/** Download + stage the available update (applied on quit). */
	download: () => Promise<void>;
	/** Install the staged update now and restart (caller must confirm first). */
	installNow: () => Promise<void>;
	/** "Later" — hide the prompt this session; re-offered on the next check. */
	dismissLater: () => void;
	/** "Skip this version" — persist it so it never re-prompts (until newer). */
	skipVersion: () => void;
	setProgress: (downloaded: number, total: number | null) => void;
}

function isSkipped(version: string): boolean {
	return useSettingsStore.getState().skippedUpdateVersion === version;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
	status: "idle",
	info: null,
	downloaded: 0,
	total: null,
	error: null,
	dismissed: false,

	setAvailable: (info) => {
		if (isSkipped(info.version)) return;
		set({ status: "available", info, dismissed: false, error: null });
	},

	check: async ({ manual = false } = {}) => {
		set({ status: "checking", error: null });
		try {
			const info = await updates.check();
			if (!info) {
				set({ status: manual ? "uptodate" : "idle" });
				return;
			}
			if (!manual && isSkipped(info.version)) {
				set({ status: "idle" });
				return;
			}
			set({ status: "available", info, dismissed: false });
		} catch (err) {
			set({ status: "error", error: String(err) });
		}
	},

	download: async () => {
		if (!get().info) return;
		set({ status: "downloading", downloaded: 0, total: null, error: null });
		try {
			await updates.download();
			set({ status: "ready" });
		} catch (err) {
			set({ status: "error", error: String(err) });
		}
	},

	installNow: async () => {
		try {
			// Resolves only if the restart didn't happen (it normally won't return).
			await updates.installNow();
		} catch (err) {
			set({ status: "error", error: String(err) });
		}
	},

	dismissLater: () => set({ dismissed: true }),

	skipVersion: () => {
		const { info } = get();
		if (info) useSettingsStore.getState().setSkippedUpdateVersion(info.version);
		set({ dismissed: true });
	},

	setProgress: (downloaded, total) => set({ downloaded, total }),
}));

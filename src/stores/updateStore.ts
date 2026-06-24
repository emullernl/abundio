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
	/** "Later" — snooze every update prompt for 24h (persisted + cross-Window). */
	dismissLater: () => void;
	/** "Skip this version" — persist it so it never re-prompts (until newer). */
	skipVersion: () => void;
	setProgress: (downloaded: number, total: number | null) => void;
}

function isSkipped(version: string): boolean {
	return useSettingsStore.getState().skippedUpdateVersion === version;
}

/** Whether "Later" is still suppressing the prompt. Version-independent: while
 *  snoozed, even a newer release stays hidden until the window expires. */
function isSnoozed(): boolean {
	const until = useSettingsStore.getState().updateSnoozedUntil;
	return until != null && until > Date.now();
}

/** How long "Later" keeps the prompt hidden — a rolling 24h. */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Canonical GitHub release page for a version — the source of truth for "what
 *  changed" (we link out rather than render the raw Markdown release notes). */
export function releaseNotesUrl(version: string): string {
	return `https://github.com/emullernl/abundio/releases/tag/v${version}`;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
	status: "idle",
	info: null,
	downloaded: 0,
	total: null,
	error: null,
	dismissed: false,

	setAvailable: (info) => {
		if (isSkipped(info.version) || isSnoozed()) return;
		set({ status: "available", info, dismissed: false, error: null });
	},

	check: async ({ manual = false } = {}) => {
		// Guard against concurrent invokes (rapid clicks, a re-emit, a second
		// caller) racing on the Rust-side `pending` slot.
		const current = get().status;
		if (current === "checking" || current === "downloading") return;
		set({ status: "checking", error: null });
		try {
			const info = await updates.check();
			if (!info) {
				set({ status: manual ? "uptodate" : "idle" });
				return;
			}
			if (!manual && (isSkipped(info.version) || isSnoozed())) {
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
		// Don't re-stage an in-flight or already-downloaded update (would discard
		// the first downloaded bundle).
		const current = get().status;
		if (current === "downloading" || current === "ready") return;
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

	dismissLater: () => {
		// Snooze every update prompt for 24h (persisted + synced across Windows),
		// not just this session — "don't bother me for the rest of the day".
		useSettingsStore.getState().setUpdateSnoozedUntil(Date.now() + SNOOZE_MS);
		set({ dismissed: true });
	},

	skipVersion: () => {
		const { info } = get();
		if (info) useSettingsStore.getState().setSkippedUpdateVersion(info.version);
		set({ dismissed: true });
	},

	setProgress: (downloaded, total) => set({ downloaded, total }),
}));

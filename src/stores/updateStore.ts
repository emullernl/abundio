import { create } from "zustand";
import {
	type ReleaseNote,
	type ReleaseNotesPage,
	type UpdateInfo,
	updates,
} from "../lib/ipc";
import {
	type MissingNotesReason,
	missingNotesReason,
	notesMissingVersion,
	releaseNoteForVersion,
	releaseNotesUrl,
} from "../lib/releaseNotes";
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
 * `pending`/`staged` live in Rust and are app-global, so a Window that did none
 * of the above still needs `hydrate` on mount to learn where the update got to.
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
	/** Adopt the app-global Rust updater state into this Window's store.
	 *  `respectSuppression` is true for the prompt (a notification, which must
	 *  obey "Later"/"Skip") and false for the Settings section (a status display,
	 *  which must never hide the truth). */
	hydrate: (opts?: { respectSuppression?: boolean }) => Promise<void>;
	/** Run a check. `manual` surfaces an "up to date" result and ignores skip. */
	check: (opts?: { manual?: boolean }) => Promise<void>;
	/** When a `check` in this Window last settled (success or error), or null.
	 *  Per-Window by design — the Settings window has its own store. */
	lastCheckedAt: number | null;
	/** Opening the Settings Updates section: adopt the Rust state, and if it
	 *  holds nothing, check exactly as the button would. Ignores the
	 *  "Automatically check for updates" toggle, which governs *background*
	 *  checks only. Throttled by `OPEN_CHECK_THROTTLE_MS`. Issue #200. */
	checkOnOpen: () => Promise<void>;
	/** Download + stage the available update (applied on quit). */
	download: () => Promise<void>;
	/** Install the staged update now and restart (caller must confirm first). */
	installNow: () => Promise<void>;
	/** "Later" — snooze every update prompt for 24h (persisted + cross-Window). */
	dismissLater: () => void;
	/** "Skip this version" — persist it so it never re-prompts (until newer). */
	skipVersion: () => void;
	setProgress: (downloaded: number, total: number | null) => void;

	// ── Release notes (ADR-0036) ──

	/** Published releases, newest first. Null until the first fetch resolves.
	 *  Deliberately **kept** when a later fetch fails, so a failed refresh does
	 *  not throw away a list that is already on screen. */
	notes: ReleaseNotesPage | null;
	notesStatus: "idle" | "loading" | "loaded" | "error";
	/** Fetch the release list. `refresh` spends a request to bypass the hourly
	 *  Rust-side cache — used by the manual "Check for updates" button. */
	fetchNotes: (opts?: { refresh?: boolean }) => Promise<void>;
	/** The version whose notes were last force-refreshed because the list
	 *  lacked it. Per-Window, like `lastCheckedAt`, so leaving and returning to
	 *  the page does not spend another uncached request on it. */
	notesRefreshedFor: string | null;
	/** Refresh the notes once when they lack the version on offer (found or
	 *  downloaded) — the hourly cache can predate that release. Reads live
	 *  state, so a fetch already in flight is waited for. */
	refreshNotesIfStale: () => void;

	/** The notes for a version the user has just upgraded onto, when Rust
	 *  decided they are worth a card. Null the rest of the time — which is
	 *  almost always. */
	whatsNew: ReleaseNote | null;
	/** Why the card is up: Rust saw an upgrade, or the user clicked the
	 *  version in the status bar. Only changes the card's wording. */
	whatsNewOrigin: "upgrade" | "manual";
	/** Set when the version button opened the card without notes, saying
	 *  why — so a failed fetch is not reported as "never published". */
	whatsNewMissing: MissingNotesReason | null;
	setWhatsNew: (note: ReleaseNote) => void;
	/** The status-bar version button (#203): open the card on the notes for
	 *  `version`, or close it when it is already up. */
	toggleWhatsNew: (version: string) => Promise<void>;
	/** Dismiss the card and record the version as seen, app-globally. */
	dismissWhatsNew: () => void;
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

/** Re-exported for existing importers; defined beside the other release-notes
 *  helpers so the URL lives in one place. */
export { releaseNotesUrl };

/** The plain (non-refresh) release-notes fetch in flight, if any. A second
 *  caller awaits it rather than returning early, so nobody reads the store
 *  mid-fetch and mistakes "still loading" for "nothing published". */
let notesInFlight: Promise<void> | null = null;

/** A repeat visit to the Updates section within this long of the last check
 *  does not check again, so clicking between Settings pages does not flash
 *  "Checking…" every time. The button always checks. */
export const OPEN_CHECK_THROTTLE_MS = 5 * 60 * 1000;

/** Stable code on Rust's refusal of a check while a download is in flight
 *  (`AbundioError::UpdateDownloading`, whose own test pins the code). */
export const UPDATE_DOWNLOADING_CODE = "E_UPDATE_DOWNLOADING";

/** Whether a check error is that refusal — a download running in another
 *  Window, which Rust deliberately does not report. Not a failure. */
export function isDownloadingElsewhere(error: string | null): boolean {
	return error?.includes(UPDATE_DOWNLOADING_CODE) ?? false;
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

	hydrate: async ({ respectSuppression = true } = {}) => {
		// Never clobber work this Window is already doing — a check or download
		// in flight holds a more current truth than the snapshot does.
		const current = get().status;
		if (current === "checking" || current === "downloading") return;
		try {
			const { state, info } = await updates.status();
			if (state === "none" || !info) return;
			if (respectSuppression && (isSkipped(info.version) || isSnoozed())) {
				return;
			}
			// Re-read after the round-trip: a check or download may have started
			// while `status()` was in flight, and that is a more current truth
			// than this snapshot. Guarding only before the await would let a
			// reply arriving mid-download flip the row back to "Install update".
			const settled = get().status;
			if (settled === "checking" || settled === "downloading") return;
			set({
				status: state === "ready" ? "ready" : "available",
				info,
				error: null,
			});
		} catch {
			// A failed hydrate is not worth surfacing — the view simply keeps
			// its "Check for updates" affordance.
		}
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
				set({
					status: manual ? "uptodate" : "idle",
					lastCheckedAt: Date.now(),
				});
				return;
			}
			if (!manual && (isSkipped(info.version) || isSnoozed())) {
				set({ status: "idle", lastCheckedAt: Date.now() });
				return;
			}
			set({
				status: "available",
				info,
				dismissed: false,
				lastCheckedAt: Date.now(),
			});
		} catch (err) {
			const error = String(err);
			// The download refusal is not a check: leave the throttle clear so
			// the next visit sees the staged result.
			set({
				status: "error",
				error,
				...(isDownloadingElsewhere(error) ? {} : { lastCheckedAt: Date.now() }),
			});
		}
	},

	lastCheckedAt: null,

	checkOnOpen: async () => {
		// Hydrate first: an update Rust already holds (found, or downloaded) is
		// the answer, and checking again would only replace it with itself.
		await get().hydrate({ respectSuppression: false });
		const { status, lastCheckedAt } = get();
		if (
			status === "available" ||
			status === "ready" ||
			status === "checking" ||
			status === "downloading"
		) {
			return;
		}
		if (
			lastCheckedAt != null &&
			Date.now() - lastCheckedAt < OPEN_CHECK_THROTTLE_MS
		) {
			return;
		}
		// Manual semantics: a status display reports skipped and snoozed
		// versions too, and says so when there is nothing new.
		await get().check({ manual: true });
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

	// ── Release notes (ADR-0036) ──

	notes: null,
	notesStatus: "idle",

	fetchNotes: ({ refresh = false } = {}) => {
		// The in-flight guard exists for the duplicate-mount case, but it must
		// not swallow a refresh: the Settings window opens straight onto this
		// section, so "Check for updates" is routinely clicked while the mount
		// fetch is still resolving. Dropping it there would quietly serve the
		// hourly cache to a user who explicitly asked for current truth.
		if (notesInFlight && !refresh) return notesInFlight;
		set({ notesStatus: "loading" });
		const request: Promise<void> = updates
			.releaseNotes(refresh)
			.then((notes) => {
				set({ notes, notesStatus: "loaded" });
			})
			.catch(() => {
				// Offline, rate-limited, or GitHub is down. The error text is not
				// worth surfacing — there is nothing the user can do differently
				// with it — and `notes` is left alone so an already-rendered list
				// survives a failed refresh rather than being replaced by an error.
				set({ notesStatus: "error" });
			})
			.finally(() => {
				// A refresh may have replaced this one as the fetch to join.
				if (notesInFlight === request) notesInFlight = null;
			});
		notesInFlight = request;
		return request;
	},

	notesRefreshedFor: null,

	refreshNotesIfStale: () => {
		const { status, info, notes, notesStatus, notesRefreshedFor } = get();
		if (status !== "available" && status !== "ready") return;
		const version = info?.version;
		// Wait for any fetch in flight: a refresh on top of it could be
		// overwritten by the older, cached reply landing second.
		if (!version || notesStatus !== "loaded") return;
		// Once per version, so a list GitHub still lacks it in cannot loop.
		if (notesRefreshedFor === version) return;
		if (!notesMissingVersion(notes, version)) return;
		set({ notesRefreshedFor: version });
		get().fetchNotes({ refresh: true });
	},

	whatsNew: null,
	whatsNewOrigin: "upgrade",
	whatsNewMissing: null,
	setWhatsNew: (note) =>
		set({ whatsNew: note, whatsNewOrigin: "upgrade", whatsNewMissing: null }),

	toggleWhatsNew: async (version) => {
		if (get().whatsNew) {
			get().dismissWhatsNew();
			return;
		}
		// Served from the hourly Rust-side cache after the first fetch. A failed
		// fetch still opens the card, saying the fetch failed. A fetch already
		// in flight is joined, not skipped (see `notesInFlight`).
		await get().fetchNotes();
		// A second click, or the upgrade card, may have landed while the fetch
		// was in flight; either way there is already an answer on screen.
		if (get().whatsNew) return;
		const { notes, notesStatus } = get();
		set({
			whatsNew: releaseNoteForVersion(version, notes?.releases ?? []),
			whatsNewOrigin: "manual",
			whatsNewMissing: missingNotesReason(
				version,
				notes,
				notesStatus === "error",
			),
		});
	},

	dismissWhatsNew: () => {
		const { whatsNew, whatsNewOrigin } = get();
		set({ whatsNew: null });
		// Rust's `last_seen_version` is the only gate on the post-upgrade card.
		// The version button can open and close the card at any time — even
		// before that card is emitted, and even with no notes in it — so only a
		// card that showed notes counts as having seen them.
		if (whatsNewOrigin !== "upgrade" && !whatsNew?.body) return;
		// Rust owns the flag: localStorage is per-webview on macOS, so a
		// per-Window copy would show the card again in the next Window.
		updates.markVersionSeen().catch(() => {});
	},
}));

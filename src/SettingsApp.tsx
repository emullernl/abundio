import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { SettingsPanel } from "./components/SettingsPanel";
import { Titlebar } from "./components/Titlebar";
import { profiles as profilesApi } from "./lib/ipc";
import { useProfileStore } from "./stores/profileStore";
import { useSettingsStore } from "./stores/settingsStore";

/**
 * Root component for the singleton Settings window (label="settings").
 *
 * Renders only the SettingsPanel — no sidebar, no workspaces, no PTYs. The
 * window's title bar uses the same Overlay chrome as profile windows so the
 * native traffic lights float over a `bg-secondary` strip.
 *
 * Cross-window settings sync (theme, font, agents) is handled by the
 * `storage` event listener registered at the bottom of this file — Tauri
 * webviews share the same `localStorage` origin, so changes here propagate
 * to every other open window's settingsStore automatically.
 */
export function SettingsApp() {
	// Load the profile list so the Profiles section in SettingsPanel has
	// data to render. The settings window has NO active profile of its own
	// — calling profileStore.loadProfiles() would reconcile-and-push an
	// activeProfileId, registering this window as an owner of (typically)
	// the first profile and conflicting with the main window. So we hit
	// the IPC directly here: fetch the list, write it into the store,
	// fetch the ownership map for "Open in another window" tooltips.
	useEffect(() => {
		(async () => {
			try {
				const list = await profilesApi.list();
				useProfileStore.setState({
					profiles: list,
					profilesLoaded: true,
					activeProfileId: null,
				});
			} catch {
				/* ignore */
			}
			useProfileStore
				.getState()
				.refreshOwnershipMap()
				.catch(() => {});
		})();
	}, []);

	// Keep this window's view of the world live: profile list changes (via
	// any window's create/rename/delete) and ownership map changes (a new
	// profile window opening, a profile window closing) need to push fresh
	// data into the settings window's stores so the Profiles section and
	// delete-confirm message reflect reality.
	useEffect(() => {
		const unlistenOwnership = listen("profile-ownership-changed", () => {
			useProfileStore
				.getState()
				.refreshOwnershipMap()
				.catch(() => {});
		});
		const unlistenProfiles = listen("profiles-changed", () => {
			useProfileStore
				.getState()
				.refreshProfiles()
				.catch(() => {});
		});
		return () => {
			unlistenOwnership.then((fn) => fn()).catch(() => {});
			unlistenProfiles.then((fn) => fn()).catch(() => {});
		};
	}, []);

	function handleClose() {
		getCurrentWindow()
			.close()
			.catch(() => {});
	}

	return (
		<>
			<Titlebar title="Settings" />
			<div
				style={{
					position: "fixed",
					top: 28,
					left: 0,
					right: 0,
					bottom: 0,
					display: "flex",
				}}
			>
				<SettingsPanel onClose={handleClose} />
			</div>
		</>
	);
}

/**
 * Cross-window settings sync via Tauri events.
 *
 * The browser-native `storage` event is documented to fire across same-origin
 * browsing contexts, but in practice on Tauri 2 (WKWebView on macOS) it
 * doesn't propagate reliably between WebviewWindows. So we use Tauri's own
 * event system instead.
 *
 * The bridge is SYMMETRIC — every window both publishes and applies changes:
 * - Each window subscribes to its own zustand store and, on every change to the
 *   shared appearance slice, emits `settings-store-changed` to all windows.
 * - Each window listens for that event, writes the payload into THIS window's
 *   localStorage in the shape zustand's `persist` middleware expects (other
 *   windows can't read our localStorage — Tauri 2 isolates it per WKWebView on
 *   macOS, so the data rides in the payload), then calls `rehydrate()`. The
 *   store's `onRehydrateStorage` hook re-applies theme CSS variables, xterm
 *   theme, and fonts.
 *
 * Symmetry is what lets a theme picked via the command palette (which runs in a
 * normal Profile window, not the Settings window) reach its siblings — the old
 * design only let the Settings window publish.
 *
 * `lastSerialized` breaks the echo loop. Tauri's `emit` also delivers to the
 * emitting window, and an applied change triggers rehydrate → store update →
 * our own subscribe. We compare a CANONICAL fingerprint produced by
 * `stableStringify` (recursive key sort) rather than `JSON.stringify`: Tauri
 * round-trips payloads through serde_json, which re-orders object keys
 * alphabetically — including the keys INSIDE each agent object. A key-order-
 * sensitive comparison would never match what we sent (locally rebuilt in
 * insertion order by `mergeAgentsWithBuiltins`), so the fingerprint would
 * flip-flop and the self-echo would spin forever, freezing the UI.
 *
 * Exposed as an explicit, idempotent setup function (called once per window
 * from main.tsx) rather than a module-eval side effect, so the registration is
 * observable and repeated imports (HMR / tests importing this module) don't
 * fan out duplicate subscribers and listeners. No-op outside a webview.
 */
let crossWindowSyncInstalled = false;
export function setupCrossWindowSync(): void {
	if (typeof window === "undefined" || crossWindowSyncInstalled) return;
	crossWindowSyncInstalled = true;
	type SettingsSlice = {
		terminalFontFamily: unknown;
		uiFontFamily: unknown;
		fontSize: unknown;
		uiFontSize: unknown;
		theme: unknown;
		agents: unknown;
		agentHooksEnabled: unknown;
		gpuAccelerationEnabled: unknown;
		smartImageDrop: unknown;
		terminalScrollback: unknown;
		markdownPreviewColorMode: unknown;
		prPollEnabled: unknown;
		prPollIntervalMinutes: unknown;
		skippedUpdateVersion: unknown;
		updateSnoozedUntil: unknown;
	};
	const sliceOf = (s: Record<string, unknown>): SettingsSlice => ({
		terminalFontFamily: s.terminalFontFamily,
		uiFontFamily: s.uiFontFamily,
		fontSize: s.fontSize,
		uiFontSize: s.uiFontSize,
		theme: s.theme,
		agents: s.agents,
		agentHooksEnabled: s.agentHooksEnabled,
		gpuAccelerationEnabled: s.gpuAccelerationEnabled,
		smartImageDrop: s.smartImageDrop,
		terminalScrollback: s.terminalScrollback,
		markdownPreviewColorMode: s.markdownPreviewColorMode,
		prPollEnabled: s.prPollEnabled,
		prPollIntervalMinutes: s.prPollIntervalMinutes,
		// Update suppression: skipping/snoozing in one Window must reach the
		// others (the Rust check emits the prompt to the focused Window only),
		// and must survive the localStorage write below. See ADR-0014.
		skippedUpdateVersion: s.skippedUpdateVersion,
		updateSnoozedUntil: s.updateSnoozedUntil,
	});
	// Fully order-independent serialization: sorts object keys recursively so a
	// payload that round-tripped through serde_json (alphabetized keys, incl.
	// inside agent objects) fingerprints identically to the locally-built slice.
	const stableStringify = (value: unknown): string => {
		if (Array.isArray(value)) {
			return `[${value.map(stableStringify).join(",")}]`;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			return `{${Object.keys(obj)
				.sort()
				.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
				.join(",")}}`;
		}
		return JSON.stringify(value) ?? "null";
	};
	const canonical = (slice: SettingsSlice) => stableStringify(slice);

	let lastSerialized = "";

	// Publish local changes to every window.
	useSettingsStore.subscribe((state) => {
		const slice = sliceOf(state as unknown as Record<string, unknown>);
		const json = canonical(slice);
		if (json === lastSerialized) return;
		lastSerialized = json;
		emit("settings-store-changed", slice).catch(() => {});
	});

	// Apply changes broadcast by any window (including our own echo, which the
	// canonical guard short-circuits).
	listen<Record<string, unknown>>("settings-store-changed", (event) => {
		const partial = event.payload;
		if (!partial || typeof partial !== "object") return;
		const json = canonical(sliceOf(partial));
		if (json === lastSerialized) return;
		// Record BEFORE rehydrate so the resulting store update doesn't echo.
		lastSerialized = json;
		try {
			// MERGE the incoming slice into this Window's existing persisted state
			// rather than replacing it — otherwise every non-synced key (skipped
			// update version, sidebar widths, shell path, …) is dropped from
			// localStorage and reset to defaults on the next launch. Preserve the
			// stored persist version so rehydrate doesn't re-run migrations.
			const raw = localStorage.getItem("abundio-settings");
			const existing = raw ? JSON.parse(raw) : {};
			const prevState =
				existing?.state && typeof existing.state === "object"
					? existing.state
					: {};
			const version =
				typeof existing?.version === "number" ? existing.version : 8;
			localStorage.setItem(
				"abundio-settings",
				JSON.stringify({ state: { ...prevState, ...partial }, version }),
			);
		} catch {
			// localStorage read/write failure — best effort, rehydrate may
			// pick up stale data but at least won't crash.
		}
		useSettingsStore.persist.rehydrate();
	}).catch(() => {});
}

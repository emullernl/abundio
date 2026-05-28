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
 * event system instead:
 *
 * - The settings window subscribes to its own zustand store. On every state
 *   change, it emits `settings-store-changed` to every other window.
 * - Every other window listens for the event and calls
 *   `useSettingsStore.persist.rehydrate()`, which re-reads localStorage (where
 *   the settings window's `persist` middleware just wrote the new value) and
 *   pushes the change into the local zustand store. The store's
 *   `onRehydrateStorage` hook then re-applies CSS variables and xterm themes.
 *
 * This runs in two halves keyed off the window label:
 * - SettingsApp window publishes
 * - Every other window subscribes
 */
if (typeof window !== "undefined") {
	const isSettingsWindow = (() => {
		try {
			return getCurrentWindow().label === "settings";
		} catch {
			return false;
		}
	})();

	if (isSettingsWindow) {
		// Subscribe to the store and broadcast the persisted slice as an
		// event PAYLOAD on every change. Other windows can't read this
		// window's localStorage (Tauri 2 isolates localStorage per
		// WKWebView on macOS), so we have to ship the data itself.
		let lastSerialized = "";
		useSettingsStore.subscribe((state) => {
			const partial = {
				terminalFontFamily: state.terminalFontFamily,
				uiFontFamily: state.uiFontFamily,
				fontSize: state.fontSize,
				uiFontSize: state.uiFontSize,
				theme: state.theme,
				agents: state.agents,
				agentHooksEnabled: state.agentHooksEnabled,
				gpuAccelerationEnabled: state.gpuAccelerationEnabled,
				terminalScrollback: state.terminalScrollback,
			};
			const json = JSON.stringify(partial);
			if (json === lastSerialized) return;
			lastSerialized = json;
			emit("settings-store-changed", partial).catch(() => {});
		});
	} else {
		// Receive the payload, write it into THIS window's localStorage in
		// the exact shape zustand's persist middleware expects, then call
		// rehydrate(). The rehydrate triggers onRehydrateStorage which
		// re-applies theme CSS variables, xterm theme, fonts — all the
		// visual side effects that don't happen automatically on setState.
		listen<Record<string, unknown>>("settings-store-changed", (event) => {
			const partial = event.payload;
			if (!partial || typeof partial !== "object") return;
			try {
				localStorage.setItem(
					"abundio-settings",
					JSON.stringify({ state: partial, version: 2 }),
				);
			} catch {
				// localStorage write failure — best effort, rehydrate may
				// pick up stale data but at least won't crash.
			}
			useSettingsStore.persist.rehydrate();
		}).catch(() => {});
	}
}

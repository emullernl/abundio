import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initNotificationListener } from "./lib/notificationRouter";
import { primaryFontFamily } from "./lib/terminalManager";
import { SettingsApp } from "./SettingsApp";
// Side-effect import: the storage-event bridge inside SettingsApp.tsx
// registers in every window so theme/font changes from the settings window
// propagate live. (See the bottom of SettingsApp.tsx.)
import "./lib/windowFocus";
import "./styles/globals.css";

/** Which OS-level Abundio window is hosting this React app. The string is
 *  evaluated synchronously at module load; safe to compare against literals. */
function currentWindowLabel(): string {
	try {
		return getCurrentWindow().label;
	} catch {
		return "main";
	}
}

const IS_SETTINGS_WINDOW = currentWindowLabel() === "settings";

// The settings window doesn't need the workspace notification router — it
// has no workspaces / PTYs / notification routing of its own.
if (!IS_SETTINGS_WINDOW) {
	initNotificationListener();
}

// Pause all CSS animations when the app is hidden to reduce GPU usage.
document.addEventListener("visibilitychange", () => {
	document.documentElement.classList.toggle("app-hidden", document.hidden);
});

// Block React render until the configured terminal font is fully loaded.
// createTerminal() also has its own preload as a safety net, but loading the
// font here means the very first paint of every terminal already has correct
// glyphs in the WebGL atlas — no flicker.
async function preloadTerminalFont(): Promise<void> {
	let fontFamily = "JetBrainsMonoNL Nerd Font Mono";
	let fontSize = 14;
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (raw) {
			const parsed = JSON.parse(raw);
			const stored = parsed?.state?.terminalFontFamily;
			if (typeof stored === "string") {
				const primary = primaryFontFamily(stored);
				if (primary) fontFamily = primary;
			}
			if (typeof parsed?.state?.fontSize === "number") {
				fontSize = parsed.state.fontSize;
			}
		}
	} catch {
		// Fall back to defaults
	}
	// Quote the family to avoid the , monospace fallback ever short-circuiting
	// FontFaceSet.load (monospace is always loadable, so a comma list returns
	// immediately without actually fetching the bundled @font-face .ttf).
	const spec = `${fontSize}px "${fontFamily}"`;
	// 3s safety net so a totally broken environment can't wedge startup forever.
	// createTerminal()'s own preload is the real safety net for individual panes.
	await Promise.race([
		Promise.all([
			document.fonts.load(spec),
			document.fonts.load(`bold ${spec}`),
			document.fonts.load(`italic ${spec}`),
		]),
		new Promise((r) => setTimeout(r, 3000)),
	]).catch(() => {});
}

function renderRoot() {
	const root = ReactDOM.createRoot(
		document.getElementById("root") as HTMLElement,
	);
	root.render(
		<React.StrictMode>
			{IS_SETTINGS_WINDOW ? <SettingsApp /> : <App />}
		</React.StrictMode>,
	);
}

if (IS_SETTINGS_WINDOW) {
	// Settings window doesn't render terminals — skip the heavyweight font
	// preload and mount immediately.
	renderRoot();
} else {
	preloadTerminalFont().finally(renderRoot);
}

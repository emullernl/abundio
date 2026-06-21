import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { disableNativeTextAssist } from "./lib/disableNativeTextAssist";
import { initNotificationListener } from "./lib/notificationRouter";
import { primaryFontFamily } from "./lib/terminalManager";
import { SettingsApp, setupCrossWindowSync } from "./SettingsApp";
import "./lib/windowFocus";
import "./styles/globals.css";

// The cross-window settings bridge runs in every window (App and Settings) so
// theme/font changes propagate live. Registered explicitly here — once per
// window — rather than as a module-eval side effect. (See SettingsApp.tsx.)
setupCrossWindowSync();

// macOS auto-capitalizes / autocorrects text fields unless each one opts out.
// Stamp the opt-out attributes globally on focus instead of per component.
disableNativeTextAssist();

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

// Probe only the main window. `!IS_SETTINGS_WINDOW` is also true for every
// `window-*` profile window, so gating on it would fan out a capture request
// per restored window on a multi-window launch (windows.json restoration).
if (currentWindowLabel() === "main") {
	probeMicrophoneAccess();
}

// Diagnostic probe: on app start, ask for microphone access so macOS shows its
// one-time TCC permission prompt (and so we can see, in the console, exactly
// where the chain breaks). `navigator.mediaDevices` is `undefined` in a
// WKWebView that isn't a secure context — surfaced separately from a denial so
// the two failure modes don't get confused. Stops the track immediately; we
// only want to trigger the prompt, not keep the mic open.
function probeMicrophoneAccess(): void {
	if (!navigator.mediaDevices?.getUserMedia) {
		console.error(
			"[mic-probe] navigator.mediaDevices.getUserMedia is unavailable — " +
				"webview is not a secure context (no NSMicrophoneUsageDescription " +
				"reached, or custom protocol not treated as secure).",
		);
		return;
	}
	navigator.mediaDevices
		.getUserMedia({ audio: true })
		.then((stream) => {
			console.log("[mic-probe] microphone access granted");
			for (const track of stream.getTracks()) track.stop();
		})
		.catch((err) => {
			console.error(
				`[mic-probe] microphone access denied or error: ${err?.name ?? "Error"}: ${err?.message ?? err}`,
			);
		});
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

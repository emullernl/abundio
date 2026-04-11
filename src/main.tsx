import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initNotificationListener } from "./lib/notificationRouter";
import { primaryFontFamily } from "./lib/terminalManager";
import "./styles/globals.css";

initNotificationListener();

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

preloadTerminalFont().finally(() => {
	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
});

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/globals.css";

// Block React render until the configured terminal font is fully loaded.
// document.fonts.check() in createTerminal() can return true for system-installed
// fallbacks while the bundled @font-face .ttf is still unfetched, causing the
// WebGL atlas to bake glyphs against the wrong font. Awaiting here guarantees
// the @font-face is downloaded and registered before any terminal is created.
async function preloadTerminalFont(): Promise<void> {
	let fontFamily = "'JetBrainsMonoNL Nerd Font Mono', monospace";
	let fontSize = 14;
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed?.state?.terminalFontFamily)
				fontFamily = parsed.state.terminalFontFamily;
			if (parsed?.state?.fontSize) fontSize = parsed.state.fontSize;
		}
	} catch {
		// Fall back to defaults
	}
	const spec = `${fontSize}px ${fontFamily}`;
	// 500ms safety net so a missing/broken font file never blocks startup forever.
	await Promise.race([
		Promise.all([
			document.fonts.load(spec),
			document.fonts.load(`bold ${spec}`),
			document.fonts.load(`italic ${spec}`),
		]),
		new Promise((r) => setTimeout(r, 500)),
	]).catch(() => {});
}

preloadTerminalFont().finally(() => {
	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
});

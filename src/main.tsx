import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/globals.css";

// Eagerly preload terminal font variants so createTerminal() doesn't block on fonts.
{
	let fontFamily = '"Berkeley Mono", monospace';
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
	Promise.all([
		document.fonts.load(spec),
		document.fonts.load(`bold ${spec}`),
		document.fonts.load(`italic ${spec}`),
	]).catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

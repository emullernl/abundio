import { getCurrentWindow } from "@tauri-apps/api/window";

// Tracks the Tauri window's focus state using native OS events. This is more
// reliable than `document.hasFocus()` inside a WebView — WKWebView in
// particular will report `false` when focus is captured by xterm.js, devtools,
// or other embedded surfaces even though the OS-level window is focused.
//
// Default to `true` so we don't spam notifications during the brief window
// between module init and the first `onFocusChanged` event.
let isWindowFocused = true;

try {
	const win = getCurrentWindow();
	win
		.isFocused()
		.then((focused) => {
			isWindowFocused = focused;
		})
		.catch(() => {
			// Non-Tauri environment (tests) — keep the default.
		});
	win
		.onFocusChanged(({ payload: focused }) => {
			isWindowFocused = focused;
		})
		.catch(() => {
			// Non-Tauri environment (tests) — keep the default.
		});
} catch {
	// getCurrentWindow() throws outside Tauri (e.g. jsdom). Fall back to the
	// document API if available.
	if (
		typeof document !== "undefined" &&
		typeof document.hasFocus === "function"
	) {
		isWindowFocused = document.hasFocus();
	}
}

export function isAppWindowFocused(): boolean {
	return isWindowFocused;
}

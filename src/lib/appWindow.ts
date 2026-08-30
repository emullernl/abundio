import { getCurrentWebview, type Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/**
 * Tauri's `getCurrentWindow()` / `getCurrentWebview()` read
 * `window.__TAURI_INTERNALS__.metadata` and **throw** when there is no Tauri
 * webview behind the React root — the browser demo (`pnpm demo:web`) and jsdom
 * tests. Every call site needs the same guard, and the ones that forgot it took
 * the whole app down through the error boundary rather than degrading.
 *
 * These helpers are that guard, in one place: `null` means "not running inside
 * a Tauri window", which callers handle by skipping the OS-level behaviour
 * (window title, close interception, focus, drag-drop) that has no meaning
 * outside one.
 */
export function appWindow(): Window | null {
	try {
		return getCurrentWindow() ?? null;
	} catch {
		return null;
	}
}

export function appWebview(): Webview | null {
	try {
		return getCurrentWebview() ?? null;
	} catch {
		return null;
	}
}

/** Which OS-level Abundio Window hosts this React root. Falls back to `"main"`
 *  outside Tauri so label comparisons and per-window storage keys still work —
 *  see `windowUiStore`'s persist key and `main.tsx`'s settings-window branch. */
export function currentWindowLabel(): string {
	return appWindow()?.label ?? "main";
}

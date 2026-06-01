import {
	readText as tauriReadText,
	writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";
import { isDemoMode } from "./demo";

// WebKitGTK (Linux) gates `navigator.clipboard.readText()` behind permission /
// user-gesture checks that the Tauri webview doesn't satisfy, so right-click
// Paste silently read nothing. Route clipboard access through the Tauri
// clipboard-manager plugin, which uses native APIs and works across platforms.
// Demo / browser mode has no Tauri runtime, so fall back to the web API there.

export async function readClipboardText(): Promise<string> {
	if (isDemoMode()) {
		try {
			return await navigator.clipboard.readText();
		} catch {
			return "";
		}
	}
	return (await tauriReadText()) ?? "";
}

export async function writeClipboardText(text: string): Promise<void> {
	if (isDemoMode()) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard write may be blocked without a user gesture.
		}
		return;
	}
	await tauriWriteText(text);
}

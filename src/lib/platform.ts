let _isMac = false;
let _isWindows = false;
try {
	const { platform } = await import("@tauri-apps/plugin-os");
	const p = platform();
	_isMac = p === "macos";
	_isWindows = p === "windows";
} catch {
	_isMac = /Mac/i.test(navigator.userAgent);
	_isWindows = /Win/i.test(navigator.userAgent);
}
export const isMac = _isMac;
export const isWindows = _isWindows;

export function sc(mac: string, other: string) {
	return isMac ? mac : other;
}

/** Which wording the "show this in the OS file manager" action uses. */
export type RevealPlatform = "mac" | "windows" | "other";

export function currentRevealPlatform(): RevealPlatform {
	return isMac ? "mac" : isWindows ? "windows" : "other";
}

/**
 * The label for revealing a path in the OS file manager, shared by the
 * **Explorer tab**'s context menu and the Git changes tab's **Row menu** so the
 * two cannot drift — the same reason the path-copy pair lives in
 * `copyPathEntries`.
 *
 * Takes the platform as an argument so it is testable without a Tauri runtime.
 */
export function revealLabel(
	platform: RevealPlatform = currentRevealPlatform(),
): string {
	switch (platform) {
		case "mac":
			return "Reveal in Finder";
		case "windows":
			return "Reveal in Explorer";
		default:
			return "Reveal in File Manager";
	}
}

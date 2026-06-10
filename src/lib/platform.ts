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

let _isMac = false;
try {
	const { platform } = await import("@tauri-apps/plugin-os");
	_isMac = platform() === "macos";
} catch {
	_isMac = /Mac/i.test(navigator.userAgent);
}
export const isMac = _isMac;

export function sc(mac: string, other: string) {
	return isMac ? mac : other;
}

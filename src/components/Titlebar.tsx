/**
 * Transparent drag region overlay for macOS titleBarStyle: "Overlay".
 * The native traffic lights sit on top of this area.
 * This is positioned absolutely so it doesn't affect layout flow.
 */
export function Titlebar() {
	return (
		<div
			data-tauri-drag-region
			className="fixed top-0 left-0 right-0 z-50 select-none"
			style={{ height: 52 }}
		/>
	);
}

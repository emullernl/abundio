import { useCallback, useRef } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

const MIN_WIDTH = 240;
const MAX_WIDTH = 800;

export function RightSidebarResizer() {
	const setRightSidebarWidth = useSettingsStore((s) => s.setRightSidebarWidth);
	const isDragging = useRef(false);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isDragging.current = true;
			document.body.classList.add("dragging");

			const onMouseMove = (ev: MouseEvent) => {
				if (!isDragging.current) return;
				const width = Math.min(
					MAX_WIDTH,
					Math.max(MIN_WIDTH, window.innerWidth - ev.clientX),
				);
				setRightSidebarWidth(width);
			};

			const onMouseUp = () => {
				isDragging.current = false;
				document.body.classList.remove("dragging");
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
			};

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[setRightSidebarWidth],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar resize
		<div
			onMouseDown={onMouseDown}
			className="transition-colors"
			// Absolutely pinned to the left edge of the right sidebar (its parent is
			// position:relative), mirroring the left sidebar's right-edge handle. By
			// living inside the sidebar it overlays the sidebar's own glow rather
			// than sitting in the content row over the flat-dark root background.
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: 4,
				height: "100%",
				zIndex: 10,
				cursor: "col-resize",
				backgroundColor: "transparent",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor = "var(--accent)";
			}}
			onMouseLeave={(e) => {
				if (!isDragging.current) {
					e.currentTarget.style.backgroundColor = "transparent";
				}
			}}
		/>
	);
}

import { useCallback, useRef } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

const MIN_WIDTH = 240;
const MAX_WIDTH = 800;

export function GitChangesResizer() {
	const setGitPanelWidth = useSettingsStore((s) => s.setGitPanelWidth);
	const isDragging = useRef(false);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isDragging.current = true;
			document.body.classList.add("dragging");

			const onMouseMove = (ev: MouseEvent) => {
				if (!isDragging.current) return;
				// Panel is on the right, so width = window width - mouseX
				const width = Math.min(
					MAX_WIDTH,
					Math.max(MIN_WIDTH, window.innerWidth - ev.clientX),
				);
				setGitPanelWidth(width);
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
		[setGitPanelWidth],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for panel resize
		<div
			onMouseDown={onMouseDown}
			className="flex-shrink-0 transition-colors"
			style={{
				width: 4,
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

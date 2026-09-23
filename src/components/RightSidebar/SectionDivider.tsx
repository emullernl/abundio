import { useCallback, useRef } from "react";

interface Props {
	onResize: (ratio: number) => void;
	onResizeEnd: () => void;
}

/** Horizontal drag handle above an expanded Anchored section (Commits
 *  or Pull Requests). Reports the pointer's height fraction; the caller turns
 *  it into a share. Renders only while that section is expanded — collapsed,
 *  the section pins itself at its header height and the divider has no role. */
export function SectionDivider({ onResize, onResizeEnd }: Props) {
	const dividerRef = useRef<HTMLDivElement>(null);
	const onResizeEndRef = useRef(onResizeEnd);
	onResizeEndRef.current = onResizeEnd;

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			document.body.classList.add("dragging");

			const parent = dividerRef.current?.parentElement;
			if (!parent) return;

			const parentRect = parent.getBoundingClientRect();

			function onMouseMove(e: MouseEvent) {
				let ratio = (e.clientY - parentRect.top) / parentRect.height;
				ratio = Math.max(0, Math.min(1, ratio));
				onResize(ratio);
			}

			function onMouseUp() {
				document.body.classList.remove("dragging");
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				onResizeEndRef.current();
			}

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[onResize],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for split resize
		<div
			ref={dividerRef}
			onMouseDown={handleMouseDown}
			className="flex-shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors"
			style={{
				height: 4,
				width: "100%",
				cursor: "row-resize",
				transitionDuration: "var(--transition-fast)",
			}}
		/>
	);
}

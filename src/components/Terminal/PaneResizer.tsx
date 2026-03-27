import { useCallback, useRef } from "react";

interface Props {
	direction: "horizontal" | "vertical";
	onResize: (ratio: number) => void;
	onResizeEnd: () => void;
}

export function PaneResizer({ direction, onResize, onResizeEnd }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			document.body.classList.add("dragging");

			const parent = containerRef.current?.parentElement;
			if (!parent) return;

			const parentRect = parent.getBoundingClientRect();

			function onMouseMove(e: MouseEvent) {
				let ratio: number;
				if (direction === "vertical") {
					ratio = (e.clientX - parentRect.left) / parentRect.width;
				} else {
					ratio = (e.clientY - parentRect.top) / parentRect.height;
				}
				ratio = Math.max(0.1, Math.min(0.9, ratio));
				onResize(ratio);
			}

			function onMouseUp() {
				document.body.classList.remove("dragging");
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				onResizeEnd();
			}

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[direction, onResize, onResizeEnd],
	);

	const isVertical = direction === "vertical";

	return (
		<div
			ref={containerRef}
			onMouseDown={handleMouseDown}
			className="flex-shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors"
			style={{
				width: isVertical ? 4 : "100%",
				height: isVertical ? "100%" : 4,
				cursor: isVertical ? "col-resize" : "row-resize",
				transitionDuration: "var(--transition-fast)",
			}}
		/>
	);
}

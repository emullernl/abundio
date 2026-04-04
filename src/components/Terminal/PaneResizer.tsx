import { useCallback, useRef } from "react";

interface Props {
	direction: "horizontal" | "vertical";
	onResizeEnd: (ratio: number) => void;
}

const RESIZER_PX = 4;

export function PaneResizer({ direction, onResizeEnd }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			document.body.classList.add("dragging");

			const el = containerRef.current;
			if (!el?.parentElement) return;

			const parent = el.parentElement;
			const parentRect = parent.getBoundingClientRect();
			const firstSibling = el.previousElementSibling as HTMLElement | null;
			const secondSibling = el.nextElementSibling as HTMLElement | null;
			if (!firstSibling || !secondSibling) return;

			let lastRatio = 0.5;

			function onMouseMove(e: MouseEvent) {
				let ratio: number;
				if (direction === "vertical") {
					ratio = (e.clientX - parentRect.left) / parentRect.width;
				} else {
					ratio = (e.clientY - parentRect.top) / parentRect.height;
				}
				ratio = Math.max(0.1, Math.min(0.9, ratio));
				lastRatio = ratio;

				if (firstSibling)
					firstSibling.style.flexBasis = `calc(${ratio * 100}% - ${RESIZER_PX / 2}px)`;
				if (secondSibling)
					secondSibling.style.flexBasis = `calc(${(1 - ratio) * 100}% - ${RESIZER_PX / 2}px)`;
			}

			function onMouseUp() {
				document.body.classList.remove("dragging");
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				onResizeEnd(lastRatio);
			}

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[direction, onResizeEnd],
	);

	const isVertical = direction === "vertical";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag resize handle
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

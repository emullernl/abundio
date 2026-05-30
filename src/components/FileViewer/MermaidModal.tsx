import { RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

const MIN_SCALE = 0.2;
const MAX_SCALE = 20;
// Fit the diagram to ~92% of the viewport, leaving a little margin around it.
const FIT_MARGIN = 0.92;

const clamp = (n: number, lo: number, hi: number) =>
	Math.min(Math.max(n, lo), hi);

/**
 * Fullscreen viewer for a rendered Mermaid diagram. Diagrams can be large and
 * shrink to fit the preview pane, so this gives a zoom/pan surface. Portaled to
 * <body> by the caller. Close via the X button or Escape.
 */
export function MermaidModal({
	svg,
	dark,
	onClose,
}: {
	svg: string;
	dark: boolean;
	onClose: () => void;
}) {
	const [scale, setScale] = useState(1);
	const [tx, setTx] = useState(0);
	const [ty, setTy] = useState(0);
	const dragRef = useRef<{ x: number; y: number } | null>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	// The scale that fits the diagram to the viewport — also the reset target.
	const fitScaleRef = useRef(1);

	const reset = useCallback(() => {
		setScale(fitScaleRef.current);
		setTx(0);
		setTy(0);
	}, []);

	// On open, scale the diagram to fit the available viewport. offsetWidth/
	// Height are the untransformed layout size, so they're safe to measure even
	// though the canvas already carries a transform.
	useLayoutEffect(() => {
		const canvas = canvasRef.current;
		const viewport = viewportRef.current;
		if (!canvas || !viewport) return;
		const cw = canvas.offsetWidth;
		const ch = canvas.offsetHeight;
		if (cw === 0 || ch === 0) return;
		const fit = clamp(
			Math.min(
				(viewport.clientWidth * FIT_MARGIN) / cw,
				(viewport.clientHeight * FIT_MARGIN) / ch,
			),
			MIN_SCALE,
			MAX_SCALE,
		);
		fitScaleRef.current = fit;
		setScale(fit);
	}, []);

	// Escape closes.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	// Wheel zoom — attached natively so it can be non-passive (preventDefault).
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	// Drag to pan.
	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			if (!dragRef.current) return;
			setTx(e.clientX - dragRef.current.x);
			setTy(e.clientY - dragRef.current.y);
		};
		const onUp = () => {
			dragRef.current = null;
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, []);

	const onMouseDown = (e: React.MouseEvent) => {
		dragRef.current = { x: e.clientX - tx, y: e.clientY - ty };
	};

	return (
		<div className="abundio-mermaid-modal">
			<div className="abundio-mermaid-modal-toolbar">
				<button
					type="button"
					title="Zoom out"
					aria-label="Zoom out"
					onClick={() => setScale((s) => clamp(s / 1.2, MIN_SCALE, MAX_SCALE))}
				>
					<ZoomOut size={14} />
				</button>
				<span className="abundio-mermaid-modal-scale">
					{Math.round(scale * 100)}%
				</span>
				<button
					type="button"
					title="Zoom in"
					aria-label="Zoom in"
					onClick={() => setScale((s) => clamp(s * 1.2, MIN_SCALE, MAX_SCALE))}
				>
					<ZoomIn size={14} />
				</button>
				<button
					type="button"
					title="Reset view"
					aria-label="Reset view"
					onClick={reset}
				>
					<RotateCcw size={14} />
				</button>
				<button
					type="button"
					title="Close"
					aria-label="Close"
					onClick={onClose}
				>
					<X size={14} />
				</button>
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-pan surface */}
			<div
				ref={viewportRef}
				className="abundio-mermaid-modal-viewport"
				onMouseDown={onMouseDown}
			>
				<div
					ref={canvasRef}
					className="abundio-mermaid-modal-canvas"
					style={{
						transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
						// A dark-themed diagram has light strokes/text, so it needs a dark
						// canvas behind it; light diagrams keep the white paper.
						background: dark ? "var(--bg-secondary)" : "#fff",
					}}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid sanitizes its own SVG output
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			</div>
		</div>
	);
}

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusSweepStore, waitForSmoothFrames } from "../../lib/focusSweep";
import { useWindowUiStore } from "../../stores/windowUiStore";

/**
 * The **Focus sweep** overlay for one Pane: a comet — bright head, fading tail
 * — that runs once clockwise around the Pane's border from the top-left corner
 * and fades out. Renders nothing between sweeps.
 *
 * Drawn above the Pane (including a WebGL terminal canvas) with
 * `pointer-events: none`, so clicks, selection and link hover pass straight
 * through. The dash lengths come from the measured perimeter in px rather
 * than SVG `pathLength`, which WebKit has not always honoured on `<rect>`.
 */
export const FocusSweep = memo(function FocusSweep({
	paneId,
	inFleetTile = false,
}: {
	paneId: string;
	/** Drawn by a Fleet tile rather than the pane's Workspace-view slot. */
	inFleetTile?: boolean;
}) {
	const nonce = useFocusSweepStore((s) => (s.paneId === paneId ? s.nonce : 0));
	// While the Fleet Console is on screen only the tile may sweep. The pane's
	// Workspace-view slot is still mounted behind the Console, and its overlay's
	// z-index is not contained by the workspace layer, so it would draw over the
	// Console across the whole width of the hidden pane.
	const fleetShowing = useWindowUiStore(
		(s) => s.fleetConsoleOpen && !s.statisticsOverlayOpen,
	);
	if (!sweepSlotDraws(nonce, fleetShowing, inFleetTile)) return null;
	return <SweepRun key={nonce} nonce={nonce} />;
});

/** Whether a sweep overlay draws: there is a sweep for this pane, and the
 *  overlay belongs to the view on screen — the tile while the Fleet Console
 *  shows, the Workspace-view slot otherwise. */
export function sweepSlotDraws(
	nonce: number,
	fleetShowing: boolean,
	inFleetTile: boolean,
): boolean {
	return nonce !== 0 && fleetShowing === inFleetTile;
}

function SweepRun({ nonce }: { nonce: number }) {
	const ref = useRef<SVGSVGElement>(null);
	// The stroke animation runs on the main thread, and the focus change that
	// starts a sweep is often the same update that makes the main thread
	// busiest — a workspace switch stalls it for ~250 ms while the newly
	// visible panes lay out and repaint. Started at once, the sweep freezes on
	// its first frame and resumes nearly finished, so it reads as cut short.
	// Hold it until frames are flowing again; normally that costs ~2 frames.
	const [started, setStarted] = useState(false);
	useEffect(() => waitForSmoothFrames(() => setStarted(true)), []);

	useLayoutEffect(() => {
		if (!started) return;
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		el.style.setProperty("--sweep-perimeter", `${2 * (width + height)}px`);
	}, [started]);

	if (!started) return null;

	return (
		<svg
			ref={ref}
			className="focus-sweep"
			aria-hidden="true"
			onAnimationEnd={(e) => {
				// Child rects animate too, and their events bubble here.
				if (e.target === e.currentTarget)
					useFocusSweepStore.getState().finish(nonce);
			}}
		>
			<rect className="focus-sweep-ring" width="100%" height="100%" />
			<rect className="focus-sweep-tail" width="100%" height="100%" />
			<rect className="focus-sweep-head" width="100%" height="100%" />
		</svg>
	);
}

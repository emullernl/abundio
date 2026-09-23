import { memo, useLayoutEffect, useRef } from "react";
import { useFocusSweepStore } from "../../lib/focusSweep";

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
}: {
	paneId: string;
}) {
	const nonce = useFocusSweepStore((s) => (s.paneId === paneId ? s.nonce : 0));
	if (!nonce) return null;
	return <SweepRun key={nonce} nonce={nonce} />;
});

function SweepRun({ nonce }: { nonce: number }) {
	const ref = useRef<SVGSVGElement>(null);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		el.style.setProperty("--sweep-perimeter", `${2 * (width + height)}px`);
	}, []);

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

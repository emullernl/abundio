import { AnimatePresence, motion } from "framer-motion";
import { useDragPaneStore } from "../lib/dragPaneStore";

interface Props {
	paneId: string;
}

export function PaneDropIndicator({ paneId }: Props) {
	const target = useDragPaneStore((s) => {
		if (!s.isDragging || !s.hoverTarget || s.hoverTarget.kind !== "pane-edge")
			return null;
		return s.hoverTarget.paneId === paneId ? s.hoverTarget : null;
	});

	const edge = target?.edge ?? null;

	const overlayStyle: React.CSSProperties = {
		position: "absolute",
		pointerEvents: "none",
		zIndex: 15,
		background: "color-mix(in srgb, var(--accent) 18%, transparent)",
	};

	if (edge === "top") {
		Object.assign(overlayStyle, {
			top: 0,
			left: 0,
			right: 0,
			height: "50%",
			borderTop: "2px solid var(--accent)",
		});
	} else if (edge === "bottom") {
		Object.assign(overlayStyle, {
			bottom: 0,
			left: 0,
			right: 0,
			height: "50%",
			borderBottom: "2px solid var(--accent)",
		});
	} else if (edge === "left") {
		Object.assign(overlayStyle, {
			top: 0,
			bottom: 0,
			left: 0,
			width: "50%",
			borderLeft: "2px solid var(--accent)",
		});
	} else if (edge === "right") {
		Object.assign(overlayStyle, {
			top: 0,
			bottom: 0,
			right: 0,
			width: "50%",
			borderRight: "2px solid var(--accent)",
		});
	}

	return (
		<AnimatePresence>
			{edge && (
				<motion.div
					key={edge}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
					style={overlayStyle}
				/>
			)}
		</AnimatePresence>
	);
}

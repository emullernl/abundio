import { AnimatePresence, motion } from "framer-motion";
import { useFileDropStore } from "../lib/fileDropStore";

interface Props {
	paneId: string;
}

/** Full-pane glow shown while an OS file is dragged over this terminal pane, so
 *  the user can see where a drop will land. Rendered inside TerminalSlot next to
 *  PaneDropIndicator; driven by `fileDropStore`. */
export function FileDropHighlight({ paneId }: Props) {
	const active = useFileDropStore((s) => s.hoverPaneId === paneId);

	return (
		<AnimatePresence>
			{active && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
					style={{
						position: "absolute",
						inset: 0,
						pointerEvents: "none",
						zIndex: 16,
						border: "2px solid var(--accent)",
						background: "color-mix(in srgb, var(--accent) 12%, transparent)",
					}}
				/>
			)}
		</AnimatePresence>
	);
}

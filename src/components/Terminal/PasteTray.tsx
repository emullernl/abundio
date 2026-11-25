import { ImageIcon, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { type TrayImage, usePasteTrayStore } from "../../stores/pasteTrayStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";

const NO_IMAGES: TrayImage[] = [];

const png = (b64: string) => `data:image/png;base64,${b64}`;

/**
 * A pane's **Paste tray** (docs/plans/paste-tray.md): thumbnails of the images
 * handed to its Agent for the prompt it has not sent yet, between the
 * terminal and the Action bar, next to where the Agent's prompt is. Like the Watch offer banner it never takes focus, so
 * typing carries on while it shows.
 */
export function PasteTray({ paneId }: { paneId: string }) {
	const ptyId = usePtyActivityStore((s) => s.panePtyMap[paneId]);
	const images = usePasteTrayStore((s) =>
		ptyId ? (s.trays[ptyId] ?? NO_IMAGES) : NO_IMAGES,
	);
	const enabled = useSettingsStore((s) => s.pasteTray);
	const [open, setOpen] = useState<TrayImage | null>(null);
	// The tray stays mounted while it draws nothing, so `open` would outlive
	// its image (tray emptied, image hidden) and pop up again on the next
	// paste. Only an image still in the tray is shown.
	const shown = open && images.some((i) => i.id === open.id) ? open : null;
	if (!enabled || !ptyId || images.length === 0) return null;
	const { remove, clear } = usePasteTrayStore.getState();
	return (
		<div
			role="status"
			aria-label="Pasted images"
			className="flex items-center gap-1.5 shrink-0 overflow-x-auto"
			style={{
				padding: "4px 6px",
				margin: "4px 8px 0 0",
				fontSize: 11.5,
				color: "var(--fg-secondary)",
				background: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				borderRadius: 6,
			}}
			// Clicks here are the tray's, not the terminal's focus handling.
			onMouseDown={(e) => e.preventDefault()}
		>
			<ImageIcon size={13} style={{ flexShrink: 0 }} />
			{images.map((image) => (
				<div key={image.id} className="group relative shrink-0">
					<button
						type="button"
						tabIndex={-1}
						title={`${image.width} × ${image.height} — click to enlarge`}
						className="block cursor-pointer rounded overflow-hidden border border-[var(--border)] hover:border-[var(--accent)]"
						style={{ height: 32 }}
						onClick={() => setOpen(image)}
					>
						<img
							src={png(image.thumb)}
							alt="Pasted"
							draggable={false}
							style={{ height: 30, width: "auto", display: "block" }}
						/>
					</button>
					<button
						type="button"
						tabIndex={-1}
						aria-label="Hide this image"
						title="Hide (the Agent keeps it)"
						className="absolute hidden group-hover:inline-flex items-center justify-center cursor-pointer rounded-full bg-[var(--bg-primary)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] border border-[var(--border)]"
						style={{ top: -4, right: -4, width: 14, height: 14 }}
						onClick={() => remove(ptyId, image.id)}
					>
						<X size={9} />
					</button>
				</div>
			))}
			<span className="flex-1" />
			<button
				type="button"
				tabIndex={-1}
				aria-label="Hide pasted images"
				title="Hide (the Agent keeps them)"
				className="inline-flex items-center justify-center cursor-pointer text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
				style={{ padding: 2 }}
				onClick={() => clear(ptyId)}
			>
				<X size={13} />
			</button>
			{shown && <PastedImageView image={shown} onClose={() => setOpen(null)} />}
		</div>
	);
}

/** The larger view of one **Pasted image**. Escape or a click outside the
 *  image closes it. React carries its mousedown up the component tree, so the
 *  pane's capture handler runs too and focuses this pane: the one the image
 *  was pasted into, which is where focus belongs after closing. */
function PastedImageView({
	image,
	onClose,
}: {
	image: TrayImage;
	onClose: () => void;
}) {
	useEscapeKey(onClose);
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Pasted image"
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ background: "rgba(0,0,0,0.6)", padding: 32 }}
			onMouseDown={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			<img
				src={png(image.full)}
				alt="Pasted"
				draggable={false}
				// Only a click outside the image closes the view.
				onMouseDown={(e) => {
					e.preventDefault();
					e.stopPropagation();
				}}
				style={{
					maxWidth: "100%",
					maxHeight: "100%",
					objectFit: "contain",
					borderRadius: 6,
					boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
				}}
			/>
		</div>,
		document.body,
	);
}

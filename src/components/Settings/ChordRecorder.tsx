import { useEffect, useRef } from "react";
import { type Chord, chordFromEvent, isModifierKey } from "../../lib/chords";

interface Props {
	/** The spelled Chord, or null for Unbound. */
	label: string | null;
	recording: boolean;
	onStart: () => void;
	onCancel: () => void;
	onUnbind: () => void;
	onRecord: (chord: Chord) => void;
	/** A key Abundio cannot bind (keypad, media keys, dead keys). Recording
	 *  stays on, so the user can simply press something else. */
	onUnsupported: () => void;
	/** For the accessible name: "Shortcut for Split right". */
	actionLabel: string;
}

/**
 * The chord pill: shows a Shortcut, and records a new one when clicked.
 *
 * While recording, keys are caught on `window` in the capture phase, before
 * anything else sees them. That matters for Escape: the Settings panel closes
 * on an Escape heard at `document` (also capture), and a window-level
 * capture listener runs first, so stopping it here keeps the window open.
 * Esc cancels, a bare Backspace unbinds, any other chord is handed up.
 */
export function ChordRecorder({
	label,
	recording,
	onStart,
	onCancel,
	onUnbind,
	onRecord,
	onUnsupported,
	actionLabel,
}: Props) {
	const ref = useRef<HTMLButtonElement>(null);
	const handlers = useRef({ onCancel, onUnbind, onRecord, onUnsupported });
	handlers.current = { onCancel, onUnbind, onRecord, onUnsupported };

	useEffect(() => {
		if (!recording) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
			if (e.key === "Escape") return handlers.current.onCancel();
			if (e.key === "Backspace" && bare) return handlers.current.onUnbind();
			// A bare modifier is the start of a chord, not a mistake.
			if (isModifierKey(e.key)) return;
			const chord = chordFromEvent(e);
			if (chord) handlers.current.onRecord(chord);
			else handlers.current.onUnsupported();
		};
		// Clicking anywhere else abandons the recording.
		const onDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) handlers.current.onCancel();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("mousedown", onDown, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("mousedown", onDown, true);
		};
	}, [recording]);

	return (
		<button
			ref={ref}
			type="button"
			onClick={recording ? onCancel : onStart}
			aria-label={`Shortcut for ${actionLabel}: ${
				recording ? "recording" : (label ?? "unbound")
			}`}
			aria-pressed={recording}
			title={
				recording
					? "Press the new shortcut. Esc cancels, Backspace removes it."
					: "Click to record a new shortcut"
			}
			className={
				"inline-flex items-center justify-center flex-shrink-0 rounded-md cursor-pointer " +
				"transition-[border-color,background-color,color,box-shadow] duration-100 " +
				(recording
					? "border border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] " +
						"shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)] animate-pulse"
					: label
						? "border border-[var(--border)] text-[var(--fg-primary)] bg-[var(--bg-secondary)] " +
							"shadow-[inset_0_-1px_0_var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
						: "border border-dashed border-[var(--border)] text-[var(--fg-secondary)] " +
							"hover:border-[var(--accent)] hover:text-[var(--accent)]")
			}
			style={{
				minWidth: 72,
				height: 24,
				padding: "0 8px",
				fontFamily: label && !recording ? "var(--font-mono)" : undefined,
				fontSize: 11.5,
				letterSpacing: label && !recording ? "0.04em" : undefined,
				whiteSpace: "nowrap",
			}}
		>
			{recording ? "Press keys…" : (label ?? "Unbound")}
		</button>
	);
}

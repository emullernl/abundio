import { useEffect, useRef, useState } from "react";
import {
	type Chord,
	chordFromEvent,
	formatHeldModifiers,
	isModifierKey,
} from "../../lib/chords";
import { isMac } from "../../lib/platform";

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
 * While recording, the modifiers held so far are shown in place of the
 * prompt, so the user sees the chord build up before the final key lands.
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
	const [held, setHeld] = useState("");

	useEffect(() => {
		if (!recording) return;
		// Read from the event's flags, not a key-by-key tally: they are right
		// on keyup too (releasing ⌘ reports metaKey false), and a modifier
		// released while the window was elsewhere cannot leave one stuck.
		const track = (e: KeyboardEvent) =>
			setHeld(
				formatHeldModifiers(
					{
						meta: e.metaKey,
						shift: e.shiftKey,
						ctrl: e.ctrlKey,
						alt: e.altKey,
					},
					isMac,
				),
			);
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			track(e);
			const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
			if (e.key === "Escape") return handlers.current.onCancel();
			if (e.key === "Backspace" && bare) return handlers.current.onUnbind();
			// A bare modifier is the start of a chord, not a mistake.
			if (isModifierKey(e.key)) return;
			const chord = chordFromEvent(e);
			if (chord) handlers.current.onRecord(chord);
			else handlers.current.onUnsupported();
		};
		const onKeyUp = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			track(e);
		};
		const onBlur = () => setHeld("");
		// Clicking anywhere else abandons the recording.
		const onDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) handlers.current.onCancel();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("blur", onBlur);
		return () => {
			setHeld("");
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("mousedown", onDown, true);
		};
	}, [recording]);

	const text = recording ? held || "Press keys…" : (label ?? "Unbound");
	const mono = recording ? !!held : !!label;

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
						"shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
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
				fontFamily: mono ? "var(--font-mono)" : undefined,
				fontSize: 11.5,
				letterSpacing: mono ? "0.04em" : undefined,
				whiteSpace: "nowrap",
			}}
		>
			{/* Keyed, and the pulse lives on the span rather than the button: an
			    opacity animation on the button itself gives it a compositing
			    layer that WebKit fills from its last paint, so the old Chord
			    stayed visible behind "Press keys…". A fresh span gets a fresh
			    paint, and the button (and its focus) survives. Keyed by the text,
			    not just the mode, so the live modifier readout gets the same. */}
			<span
				key={`${recording ? "recording" : "idle"}:${text}`}
				className={recording ? "animate-pulse" : undefined}
			>
				{text}
			</span>
		</button>
	);
}

/** Minimal shape of the fields we read off a KeyboardEvent — kept as a plain
 *  interface so the logic is unit-testable without constructing a real DOM
 *  KeyboardEvent. */
export interface NavKeyEvent {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * Decide what the shell line editor should receive for a modified navigation
 * keypress, defusing the modified-arrow / nav-key CSI sequences that xterm
 * emits but the default bash/zsh keymaps leave unbound (which otherwise leak
 * into the line as visible "codes"). Returns:
 *   - a byte sequence to send — Alt or Ctrl + Left/Right jump one word,
 *   - "" — handled but silent: combos with no useful shell action,
 *   - null — not ours; let xterm send its normal sequence.
 *
 * Word movement emits ESC-b / ESC-f (backward-word / forward-word), bound out
 * of the box in both bash's readline and zsh's emacs keymap. Cmd combos are
 * always left to the app, and unmodified nav keys are left to the shell (those
 * are already bound) — only modified combos are claimed.
 */
export function modifiedNavKeySequence(event: NavKeyEvent): string | null {
	// Cmd combos are app/OS shortcuts — never ours.
	if (event.metaKey) return null;
	// Unmodified nav keys (plain ←, Home, Delete, …) are already bound by the
	// shell; only the modified variants leak as codes.
	if (!event.altKey && !event.ctrlKey && !event.shiftKey) return null;

	switch (event.key) {
		case "ArrowLeft":
		case "ArrowRight":
			// Alt or Ctrl (without Shift) → one-word movement.
			if ((event.altKey || event.ctrlKey) && !event.shiftKey) {
				return event.key === "ArrowLeft" ? "\x1bb" : "\x1bf";
			}
			// Shift+Arrow (e.g. an attempted text selection) has no shell action.
			return "";
		case "ArrowUp":
		case "ArrowDown":
			// No word/line equivalent for vertical movement.
			return "";
		case "Home":
		case "End":
		case "Delete":
		case "PageUp":
		case "PageDown":
			// Modified Home/End/Delete/PageUp/PageDown (`\e[1;N{H,F}`, `\e[3;N~`,
			// `\e[5;N~`, `\e[6;N~`) are unbound by default — swallow so they don't
			// leak as codes.
			return "";
		default:
			return null;
	}
}

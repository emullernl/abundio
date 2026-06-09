/** Minimal shape of the fields we read off a KeyboardEvent — kept as a plain
 *  interface so the logic is unit-testable without constructing a real DOM
 *  KeyboardEvent. */
export interface WordJumpKeyEvent {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * Decide how to handle a plain Alt+Arrow keypress for the shell line editor.
 * Returns:
 *  - the byte sequence to send for Alt+Left / Alt+Right (one-word movement),
 *  - "" for Alt+Up / Alt+Down — handled but silent (send nothing),
 *  - null for anything else — caller should let xterm handle it.
 *
 * Left/Right emit ESC-b / ESC-f (backward-word / forward-word) rather than
 * xterm's default modified-arrow sequence (`\e[1;3D` / `\e[1;3C`): ESC-b /
 * ESC-f are bound to word movement out of the box in both bash's readline and
 * zsh's emacs keymap, whereas `\e[1;3x` is unbound by default and leaked into
 * the line as visible "codes". Up/Down have no word equivalent, so we swallow
 * them too — same "codes" leak, nothing useful to send. Plain Alt only — Alt
 * with Shift/Ctrl/Cmd is left to xterm so selection and other modified-arrow
 * behaviours are unaffected.
 */
export function altArrowWordJumpSequence(
	event: WordJumpKeyEvent,
): string | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	if (event.key === "ArrowLeft") return "\x1bb";
	if (event.key === "ArrowRight") return "\x1bf";
	if (event.key === "ArrowUp" || event.key === "ArrowDown") return "";
	return null;
}

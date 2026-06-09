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
 * Translate an Alt+ArrowLeft / Alt+ArrowRight keypress into the byte sequence
 * that moves the shell's line-editor cursor one word, or null for any other
 * key combination (caller should let xterm handle those).
 *
 * We emit ESC-b / ESC-f (backward-word / forward-word) rather than xterm's
 * default modified-arrow sequence (`\e[1;3D` / `\e[1;3C`): ESC-b / ESC-f are
 * bound to word movement out of the box in both bash's readline and zsh's
 * emacs keymap, whereas `\e[1;3x` is unbound by default and leaked into the
 * line as visible "codes". Plain Alt only — Alt with Shift/Ctrl/Cmd is left to
 * xterm so selection and other modified-arrow behaviours are unaffected.
 */
export function altArrowWordJumpSequence(
	event: WordJumpKeyEvent,
): string | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	if (event.key === "ArrowLeft") return "\x1bb";
	if (event.key === "ArrowRight") return "\x1bf";
	return null;
}

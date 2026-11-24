/**
 * **Shift+Enter new line**: bare Shift+Enter sends what Option/Alt+Enter
 * sends, ESC + CR (`\x1b\r`). xterm.js sends a plain CR for Shift+Enter, so
 * an Agent's prompt was submitted where the user wanted a new line; the
 * Agents read ESC + CR as "insert a new line" (it is what Claude Code's own
 * `/terminal-setup` configures elsewhere), and zsh's line editor inserts a
 * literal new line for it too.
 *
 * Applies on the normal screen, and on the alternate screen only in an
 * agent-mode pane: full-screen programs that are not Agents (vim, lazygit)
 * would read ESC + CR as "leave insert mode, then Enter".
 */

export const SHIFT_ENTER_SEQUENCE = "\x1b\r";

/** The KeyboardEvent fields this reads, so it is testable without a DOM. */
export interface ShiftEnterKeyEvent {
	key: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	isComposing?: boolean;
}

export interface ShiftEnterContext {
	/** The terminal is showing its alternate screen buffer. */
	alternateScreen: boolean;
	/** The pane's PTY is in agent mode. */
	agentMode: boolean;
}

/** The bytes to send for this keypress, or null to leave it to xterm. */
export function shiftEnterSequence(
	event: ShiftEnterKeyEvent,
	ctx: ShiftEnterContext,
): string | null {
	if (event.key !== "Enter" || !event.shiftKey) return null;
	if (event.altKey || event.ctrlKey || event.metaKey) return null;
	// An input method is composing: Enter commits the composition.
	if (event.isComposing) return null;
	if (ctx.alternateScreen && !ctx.agentMode) return null;
	return SHIFT_ENTER_SEQUENCE;
}

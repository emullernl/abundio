/**
 * **Shift+Enter new line**: bare Shift+Enter sends what Option/Alt+Enter
 * sends, ESC + CR (`\x1b\r`). xterm.js sends a plain CR for Shift+Enter, so
 * an Agent's prompt was submitted where the user wanted a new line; the
 * Agents read ESC + CR as "insert a new line" (it is what Claude Code's own
 * `/terminal-setup` configures elsewhere), and zsh's line editor inserts a
 * literal new line for it too.
 *
 * Applies always in an agent-mode pane, whichever screen the Agent draws on.
 * Outside agent mode it applies only at the shell's prompt: a program the
 * shell is running may read the leading ESC as "cancel" (clack and inquirer
 * prompts, `read -p`, REPLs), and full-screen programs (vim, lazygit) as
 * "leave insert mode, then Enter". Those keep a plain Enter. A shell without
 * shell integration never reports a running command, so there it applies
 * outside the alternate screen.
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
	/** Shell integration reports a command running (not at the prompt). */
	commandRunning: boolean;
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
	if (!ctx.agentMode && (ctx.alternateScreen || ctx.commandRunning)) {
		return null;
	}
	return SHIFT_ENTER_SEQUENCE;
}

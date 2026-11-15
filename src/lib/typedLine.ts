/**
 * Text typed into a pane's shell as one line: control characters (newlines,
 * CR, ESC, …) become spaces, so it cannot carry its own Enter, be split into
 * two commands, or smuggle in escape sequences.
 */
export function oneLine(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we strip control characters
	return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}

/**
 * The bytes to write to a PTY to type `text` and press Enter. Every command
 * Abundio types into a shell (a **Typed launch**, `pane run`) goes through
 * here.
 *
 * Enter is CR (`\r`), the byte a real Enter key sends. LF (`\n`) only looks
 * like Enter to zsh and bash; on Windows ConPTY reports it as Ctrl+Enter,
 * which PowerShell's line editor reads as "insert a line", so the command sat
 * on a `>>` continuation line and never ran.
 */
export function typedLine(text: string): string {
	return `${oneLine(text)}\r`;
}

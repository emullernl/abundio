// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we strip control characters
const CONTROL_BUT_NL_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * The text of an `abundio agent prompt`, made safe to paste. It comes from
 * another Agent, which may be repeating what it read in a file or a web page,
 * so it is treated like a Prompt action's parameter *value*: control
 * characters go. Unlike a value, its newlines and tabs stay, because a prompt
 * is prose. Removing ESC is what stops an embedded `ESC[201~` from closing
 * the bracketed paste early and turning the rest into keystrokes. Line ends
 * are normalised to `\n`; the paste carries them inside the bracketed-paste
 * guard, where an Agent reads them as new lines, not as Enter.
 */
export function cleanPromptText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(CONTROL_BUT_NL_TAB, "");
}

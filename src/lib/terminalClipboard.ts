import { readClipboardText, writeClipboardText } from "./clipboard";
import { getTerminal } from "./terminalManager";

// Shared copy/paste for a terminal pane, used by both the right-click context
// menu (TerminalSlot) and the keyboard shortcuts (registered in App.tsx).
// Clipboard access goes through the Tauri plugin (see clipboard.ts) so paste
// works on WebKitGTK/Linux where navigator.clipboard.readText() is gated.

export function copyTerminalSelection(paneId: string): void {
	const selection = getTerminal(paneId)?.term.getSelection();
	if (selection) {
		void writeClipboardText(selection);
	}
}

export async function pasteIntoTerminal(paneId: string): Promise<void> {
	const managed = getTerminal(paneId);
	if (!managed?.ptyId) return;
	const text = await readClipboardText();
	if (text) {
		// Route through xterm rather than writing to the PTY directly: when the
		// shell has bracketed-paste mode on (bash/zsh default), term.paste wraps
		// the text in \e[200~ … \e[201~ so a clipboard ending in a newline is
		// inserted, not auto-executed. It emits via onData → pty.write.
		managed.term.paste(text);
	}
}

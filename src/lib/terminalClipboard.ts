import { readClipboardText, writeClipboardText } from "./clipboard";
import { pty } from "./ipc";
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
		pty.write(managed.ptyId, text);
	}
}

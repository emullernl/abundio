// The **Paste tray** (docs/plans/paste-tray.md): which pastes add a
// **Pasted image**, and when the tray empties.

import { usePasteTrayStore } from "../stores/pasteTrayStore";
import {
	type StatusSnapshot,
	subscribeStatusChange,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { clipboardImage, type PastedImage } from "./ipc";

/** The Agent's paste keystroke (Ctrl+V). Agents that read a clipboard image
 *  (Claude Code, Gemini CLI) do so when they receive it. */
export const CTRL_V = "\x16";

/** PTYs whose next typed Ctrl+V was sent by **Smart image paste**, which has
 *  already added the image, so the typed-key path must not add it again. */
const sentByAbundio = new Set<string>();

/** Whether a status change empties the tray: the Agent took the prompt
 *  (Working), or the pane left agent mode (the Agent exited). */
export function clearsTray(
	prev: StatusSnapshot,
	next: StatusSnapshot,
): boolean {
	if (next.detectionMode !== "agent") return true;
	return next.state === "active" && prev.state !== "active";
}

export function isAgentPty(ptyId: string): boolean {
	return (
		usePtyActivityStore.getState().activities[ptyId]?.detectionMode === "agent"
	);
}

function addToTray(ptyId: string, image: PastedImage): void {
	if (useSettingsStore.getState().pasteTray && isAgentPty(ptyId)) {
		usePasteTrayStore.getState().add(ptyId, image);
	}
}

/** The user typed Ctrl+V into `ptyId` (the byte goes to the PTY untouched). */
export function noteTypedCtrlV(ptyId: string): void {
	if (sentByAbundio.delete(ptyId)) return;
	void notePastedImage(ptyId);
}

/** The clipboard was just pasted into `ptyId`'s Agent: add its image to the
 *  tray, if there is one and the tray is on. Never throws. */
export async function notePastedImage(ptyId: string): Promise<void> {
	if (!useSettingsStore.getState().pasteTray || !isAgentPty(ptyId)) return;
	try {
		const image = await clipboardImage.peek();
		if (image) addToTray(ptyId, image);
	} catch (err) {
		console.warn("[pasteTray] could not read the clipboard image:", err);
	}
}

/** Empty each tray when its status says so. Started by `App.tsx`, not at
 *  import: this module is imported by `terminalManager`, which loads while
 *  `ptyActivityStore` is still initialising. Returns the unsubscribe. */
export function startPasteTray(): () => void {
	return subscribeStatusChange(({ ptyId, prev, next }) => {
		if (clearsTray(prev, next)) usePasteTrayStore.getState().clear(ptyId);
	});
}

/** Whether the paste shortcut should send the clipboard's image instead of
 *  its text (**Smart image paste**): an agent-mode PTY, the Smart image drop
 *  setting on, and an image with neither text nor copied files (Rust's rule,
 *  so `image` is null otherwise). */
export function shouldSmartPaste(
	agentMode: boolean,
	settingOn: boolean,
	image: PastedImage | null,
): image is PastedImage {
	return agentMode && settingOn && image !== null;
}

/** **Smart image paste**: the paste shortcut was pressed in `ptyId`. If the
 *  clipboard holds only an image, send the Agent its paste keystroke through
 *  `send` (a typed-input path, so the input bookkeeping matches a keystroke)
 *  and add the image to the tray. True when it did. Never throws. */
export async function smartImagePaste(
	ptyId: string,
	send: (data: string) => void,
): Promise<boolean> {
	if (!isAgentPty(ptyId) || !useSettingsStore.getState().smartImageDrop) {
		return false;
	}
	let image: PastedImage | null = null;
	try {
		image = await clipboardImage.peek();
	} catch (err) {
		console.warn("[pasteTray] could not read the clipboard image:", err);
		return false;
	}
	if (
		!shouldSmartPaste(
			isAgentPty(ptyId),
			useSettingsStore.getState().smartImageDrop,
			image,
		)
	) {
		return false;
	}
	sentByAbundio.add(ptyId);
	send(CTRL_V);
	// `send` normally reaches the typed-key path at once; never leave the
	// mark behind to swallow the user's own next Ctrl+V.
	sentByAbundio.delete(ptyId);
	addToTray(ptyId, image);
	return true;
}

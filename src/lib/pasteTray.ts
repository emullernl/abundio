// The **Paste tray** (docs/plans/paste-tray.md): which pastes add a
// **Pasted image**, and when the tray empties.

import { usePasteTrayStore } from "../stores/pasteTrayStore";
import {
	type StatusSnapshot,
	subscribeStatusChange,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { clipboardImage } from "./ipc";

/** The Agent's paste keystroke (Ctrl+V). Agents that read a clipboard image
 *  (Claude Code, Gemini CLI) do so when they receive it. */
export const CTRL_V = "\x16";

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

/** A Ctrl+V reached `ptyId` through typed input (the byte goes to the PTY
 *  untouched): the user's own, or one **Smart image paste** sent. */
export function noteTypedCtrlV(ptyId: string): void {
	void notePastedImage(ptyId);
}

/** The clipboard was just pasted into `ptyId`'s Agent: add its image to the
 *  tray, if there is one and the tray is on. Never throws. */
export async function notePastedImage(ptyId: string): Promise<void> {
	if (!useSettingsStore.getState().pasteTray || !isAgentPty(ptyId)) return;
	try {
		const image = await clipboardImage.peek();
		if (image && useSettingsStore.getState().pasteTray && isAgentPty(ptyId)) {
			usePasteTrayStore.getState().add(ptyId, image);
		}
	} catch (err) {
		console.warn("[pasteTray] could not read the clipboard image:", err);
	}
}

/** Empty each tray when its status says so, and free it when its PTY is
 *  gone (pane or Workspace closed, restarted): removing a PTY emits no status
 *  change, and a tray can hold megabytes of images. Started by `App.tsx`, not
 *  at import: this module is imported by `terminalManager`, which loads while
 *  `ptyActivityStore` is still initialising. Returns the unsubscribe. */
export function startPasteTray(): () => void {
	const offStatus = subscribeStatusChange(({ ptyId, prev, next }) => {
		if (clearsTray(prev, next)) usePasteTrayStore.getState().clear(ptyId);
	});
	const offRemoved = usePtyActivityStore.subscribe((s) => {
		const { trays, clear } = usePasteTrayStore.getState();
		for (const ptyId of Object.keys(trays)) {
			if (!s.activities[ptyId]) clear(ptyId);
		}
	});
	return () => {
		offStatus();
		offRemoved();
	};
}

/** Whether the paste shortcut should send the clipboard's image instead of
 *  its text (**Smart image paste**): an agent-mode PTY, the Smart image drop
 *  setting on, and an image with neither text nor copied files (Rust's rule). */
export function shouldSmartPaste(
	agentMode: boolean,
	settingOn: boolean,
	isImagePaste: boolean,
): boolean {
	return agentMode && settingOn && isImagePaste;
}

/** **Smart image paste**: the paste shortcut was pressed in `ptyId`. If the
 *  clipboard holds only an image, send the Agent its paste keystroke through
 *  `send`, a typed-input path: the input bookkeeping matches a keystroke, and
 *  the typed Ctrl+V adds the image to the tray afterwards, so the paste never
 *  waits on thumbnails. True when it sent. Never throws. */
export async function smartImagePaste(
	ptyId: string,
	send: (data: string) => void,
): Promise<boolean> {
	if (!isAgentPty(ptyId) || !useSettingsStore.getState().smartImageDrop) {
		return false;
	}
	let isImagePaste = false;
	try {
		isImagePaste = await clipboardImage.isImagePaste();
	} catch (err) {
		console.warn("[pasteTray] could not read the clipboard:", err);
		return false;
	}
	if (
		!shouldSmartPaste(
			isAgentPty(ptyId),
			useSettingsStore.getState().smartImageDrop,
			isImagePaste,
		)
	) {
		return false;
	}
	send(CTRL_V);
	return true;
}

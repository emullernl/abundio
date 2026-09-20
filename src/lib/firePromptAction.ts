/**
 * The impure half of **Firing** a Prompt action: focus the pane, paste the
 * resolved body, submit.
 *
 * The decisions all live in `promptActions.ts` (pure, tested). This module only
 * carries them out, in the same shape `useTerminalFileDrop` does.
 */

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { pulse } from "./promptActionPulse";
import {
	canFire,
	type ParamMetaMap,
	type ParamValue,
	resolveBody,
} from "./promptActions";
import { getTerminal } from "./terminalManager";

export interface FireOptions {
	/** The Prompt action's id, so the **Action bar** can pulse the button that
	 *  actually sent. Optional only because the resolution helpers below do not
	 *  need it; every real call site passes one. */
	actionId?: string;
	/** Alt/Option-click: paste the text but withhold the trailing `\r`, so it
	 *  sits in the Agent's prompt box for the user to add to. */
	stageOnly?: boolean;
}

export type FireResult =
	| { ok: true }
	| { ok: false; reason: "no-terminal" | "waiting" };

/**
 * Write a resolved prompt into a pane's PTY.
 *
 * Order matters and is deliberate:
 *
 * 1. **Focus the pane first.** The user is about to talk to that Agent; leaving
 *    focus elsewhere sends their next keystroke to the wrong place. **File
 *    drop** focuses on drop for the same reason.
 * 2. **Refuse while Waiting.** A permission prompt has redefined what
 *    keystrokes mean — see `canFire`. Checked here as well as in the UI so the
 *    guard holds even if a caller forgets to disable its button.
 * 3. **`term.paste()`, not a raw write.** It wraps in `ESC[200~ … ESC[201~`
 *    when the receiving program has bracketed-paste on, which is what makes a
 *    multi-line body arrive as text instead of as several submits.
 * 4. **The `\r` goes separately**, after the paste, so it is never inside the
 *    paste guard — the submit must be a submit, not pasted text.
 */
export function firePromptAction(
	paneId: string,
	body: string,
	params: ParamMetaMap,
	values: Record<string, ParamValue>,
	opts: FireOptions = {},
): FireResult {
	const managed = getTerminal(paneId);
	if (!managed?.ptyId) return { ok: false, reason: "no-terminal" };

	const state = usePtyActivityStore.getState().activities[managed.ptyId]?.state;
	if (!canFire(state)) return { ok: false, reason: "waiting" };

	useWorkspaceStore.getState().setFocusedPane(paneId);

	const text = resolveBody(body, params, values);
	managed.term.paste(text);
	if (!opts.stageOnly) {
		// `\r`, not `\n`: a TUI's line discipline reads CR as submit, and xterm's
		// own key handling sends CR for Enter.
		managed.term.input("\r");
	}

	// Focus lands in the terminal, never on the button — the next thing the user
	// does is watch or type.
	managed.term.focus();

	// After the write, not before: the pulse says "that went out", so it must
	// not fire for a refused send.
	if (opts.actionId) pulse(paneId, opts.actionId);
	return { ok: true };
}

/** The canonical agent-mode test, matching `useTerminalFileDrop`. `agentPtyIds`
 *  is kept in lockstep with `detectionMode` but is not the source of truth. */
export function isAgentPane(ptyId: string | undefined): boolean {
	if (!ptyId) return false;
	return (
		usePtyActivityStore.getState().activities[ptyId]?.detectionMode === "agent"
	);
}

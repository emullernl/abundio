/**
 * Lets an app-level keybinding reach a pane-local Prompt action handler.
 *
 * `registerAction` in `keybindings.ts` holds **one** handler per action, and
 * it is registered once in `App.tsx`. But firing a **position number** needs
 * two things that only a pane has: the ordered list for *that* pane's Agent,
 * and somewhere to put the parameter dialog. So each `TerminalSlot` registers
 * its own fire-by-slot function here, and the app-level handler resolves the
 * focused pane and calls it.
 *
 * Same shape as `portalRegistry` and `snapshotRegistry` — a plain module map
 * keyed by pane id, not a store, because nothing renders from it.
 */

import type { PromptAction } from "./promptActions";

export interface PaneFireHandlers {
	/** Fire the `slot`-th (1-based) bar button. Used by the digit bindings. */
	bySlot: (slot: number, stageOnly: boolean) => void;
	/** Fire a named action. Used by the Command palette, which resolves the
	 *  action itself and so has no slot to pass. */
	byAction: (action: PromptAction, stageOnly: boolean) => void;
}

const handlers = new Map<string, PaneFireHandlers>();

export function registerPaneFire(paneId: string, fns: PaneFireHandlers): void {
	handlers.set(paneId, fns);
}

export function unregisterPaneFire(paneId: string): void {
	handlers.delete(paneId);
}

/**
 * Fire the `slot`-th (1-based) bar button in a pane.
 *
 * A pane with no registered handler, or a slot past the end of its bar, is a
 * no-op — the digit simply does nothing, which is what a user pressing ⌘7 over
 * a three-button bar should experience.
 */
export function firePaneSlot(
	paneId: string | null,
	slot: number,
	stageOnly: boolean,
): void {
	if (!paneId) return;
	handlers.get(paneId)?.bySlot(slot, stageOnly);
}

/** Fire a specific action in a pane, from the Command palette. */
export function firePaneAction(
	paneId: string | null,
	action: PromptAction,
	stageOnly = false,
): void {
	if (!paneId) return;
	handlers.get(paneId)?.byAction(action, stageOnly);
}

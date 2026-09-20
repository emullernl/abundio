/**
 * Close the **topmost** overlay on Escape.
 *
 * ## Why a document listener
 *
 * The obvious `onKeyDown` on a backdrop does not work for these dialogs. The
 * card inside stops propagation — it has to, or keystrokes reach the terminal
 * behind it — and focus is placed inside the card on mount, so the key event
 * never reaches the backdrop's handler at all. Every dialog in this app that
 * wrote `onKeyDown={(e) => e.key === "Escape" && onCancel()}` on its backdrop
 * has silently done nothing. `PaneContextMenu` already listens on `document`
 * for the same reason.
 *
 * ## Why a stack rather than one listener per dialog
 *
 * Listeners on the same node fire in **registration order**, and mount order
 * runs outermost-first. So a plain per-dialog listener gives Escape to the
 * *outer* overlay while the inner one is on top — and `stopPropagation` cannot
 * fix it, because it does not stop other listeners on the same node.
 *
 * Keeping one shared stack and dispatching only to its last entry gets the
 * ordering right: a confirmation opened on top of an editor takes the Escape,
 * the editor keeps it once the confirmation is gone, and neither closes both.
 */

import { useEffect, useRef } from "react";

type Handler = () => void;

const stack: Handler[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Escape") return;
	// Indexed rather than `.at(-1)`: the project's TS target predates it.
	const top = stack[stack.length - 1];
	if (!top) return;
	// Claim the key: nothing behind this overlay should also act on it.
	e.preventDefault();
	e.stopPropagation();
	top();
}

function ensureListening() {
	if (listening) return;
	document.addEventListener("keydown", onKeyDown, true);
	listening = true;
}

function stopListeningIfIdle() {
	if (stack.length > 0 || !listening) return;
	document.removeEventListener("keydown", onKeyDown, true);
	listening = false;
}

/**
 * True while any overlay registered here is on screen.
 *
 * Used to suppress keystrokes that would act on what is *behind* the overlay.
 * The stack already tracks exactly this, so nothing else has to.
 */
export function hasOverlay(): boolean {
	return stack.length > 0;
}

/**
 * Register `onEscape` for as long as the component is mounted.
 *
 * The callback is read through a ref, so a caller passing an inline arrow does
 * not re-order the stack on every render — which would quietly promote an
 * outer dialog above an inner one.
 */
export function useEscapeKey(onEscape: () => void): void {
	const latest = useRef(onEscape);
	latest.current = onEscape;

	useEffect(() => {
		const entry: Handler = () => latest.current();
		stack.push(entry);
		ensureListening();
		return () => {
			const at = stack.lastIndexOf(entry);
			if (at >= 0) stack.splice(at, 1);
			stopListeningIfIdle();
		};
	}, []);
}

/**
 * Tells an **Action bar** that one of its buttons just sent something.
 *
 * Emitted from `firePromptAction`, which is where every path converges — the
 * button, the digit shortcut, the **Command palette**, and the parameter
 * dialog's Send. Emitting from the click instead would pulse when a
 * parameterised action merely *opens its dialog*, and again if the user then
 * cancelled, which is the opposite of what the animation says.
 *
 * A plain module map keyed by pane, like `portalRegistry` and
 * `promptActionRegistry`. It carries no state worth rendering from — a pulse
 * is an event, not a value, so there is nothing for a store to hold.
 */

export interface PulseEvent {
	actionId: string;
	/** Distinguishes consecutive sends of the *same* action, which are otherwise
	 *  identical and would not re-trigger an animation keyed on the id alone. */
	nonce: number;
}

type Listener = (event: PulseEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let counter = 0;

export function subscribePulse(paneId: string, fn: Listener): () => void {
	let set = listeners.get(paneId);
	if (!set) {
		set = new Set();
		listeners.set(paneId, set);
	}
	set.add(fn);
	return () => {
		set.delete(fn);
		if (set.size === 0) listeners.delete(paneId);
	};
}

/** Announce a send. No-ops when nothing is listening, which is the normal case
 *  for a pane whose bar is switched off. */
export function pulse(paneId: string, actionId: string): void {
	const set = listeners.get(paneId);
	if (!set?.size) return;
	counter += 1;
	const event: PulseEvent = { actionId, nonce: counter };
	for (const fn of set) fn(event);
}

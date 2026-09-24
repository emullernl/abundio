/**
 * Where each pane's terminal is drawn.
 *
 * A pane can have several registered targets at once: its slot in the
 * Workspace view, plus a Fleet tile that borrows it while the Fleet Console is
 * open (ADR-0040). The live target is the one with the highest priority, and
 * among equal priorities the most recently registered. Unregistering a target
 * that is not live changes nothing on screen, so a tile hands the terminal
 * back simply by unregistering, and a Workspace-view slot that remounts while
 * a tile holds the terminal cannot steal it back.
 */

type TargetChangeCallback = (el: HTMLDivElement | null) => void;

interface Entry {
	el: HTMLDivElement;
	priority: number;
	seq: number;
}

/** Priority of a Fleet tile's target: above every Workspace-view slot. */
export const FLEET_TILE_PRIORITY = 1;

const targets = new Map<string, Entry[]>();
const listeners = new Map<string, Set<TargetChangeCallback>>();
let nextSeq = 0;

function live(paneId: string): HTMLDivElement | null {
	const entries = targets.get(paneId);
	if (!entries || entries.length === 0) return null;
	let best = entries[0];
	for (const e of entries) {
		if (
			e.priority > best.priority ||
			(e.priority === best.priority && e.seq > best.seq)
		) {
			best = e;
		}
	}
	return best.el;
}

function notify(paneId: string, el: HTMLDivElement | null) {
	const cbs = listeners.get(paneId);
	if (cbs) {
		for (const cb of cbs) cb(el);
	}
}

export function registerTarget(
	paneId: string,
	el: HTMLDivElement,
	priority = 0,
): void {
	const before = live(paneId);
	const entries = (targets.get(paneId) ?? []).filter((e) => e.el !== el);
	entries.push({ el, priority, seq: nextSeq++ });
	targets.set(paneId, entries);
	const after = live(paneId);
	if (after !== before) notify(paneId, after);
}

/**
 * Remove one target, or every target of the pane when `el` is omitted.
 * Listeners hear about it only when the live target changes.
 */
export function unregisterTarget(paneId: string, el?: HTMLDivElement): void {
	const before = live(paneId);
	const entries = targets.get(paneId);
	if (!entries) return;
	const rest = el ? entries.filter((e) => e.el !== el) : [];
	if (rest.length === 0) targets.delete(paneId);
	else targets.set(paneId, rest);
	const after = live(paneId);
	if (after !== before) notify(paneId, after);
}

export function getTarget(paneId: string): HTMLDivElement | null {
	return live(paneId);
}

export function listTargets(): [string, HTMLDivElement][] {
	const out: [string, HTMLDivElement][] = [];
	for (const paneId of targets.keys()) {
		const el = live(paneId);
		if (el) out.push([paneId, el]);
	}
	return out;
}

export function onTargetChange(
	paneId: string,
	cb: TargetChangeCallback,
): () => void {
	let set = listeners.get(paneId);
	if (!set) {
		set = new Set();
		listeners.set(paneId, set);
	}
	set.add(cb);
	return () => {
		set?.delete(cb);
		if (set?.size === 0) listeners.delete(paneId);
	};
}

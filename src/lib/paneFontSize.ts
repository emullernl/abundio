/**
 * The font size each terminal pane is actually drawn at: the global terminal
 * font size, times the **Tile zoom** while the pane is a Fleet tile.
 * `terminalManager` publishes it whenever it applies a size; chrome that should
 * scale with the terminal text (the **Action bar**) reads it here, so it does
 * not have to import the terminal manager and its xterm dependencies.
 */

import { useCallback, useSyncExternalStore } from "react";

const sizes = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function publishPaneFontSize(paneId: string, size: number): void {
	if (sizes.get(paneId) === size) return;
	sizes.set(paneId, size);
	for (const cb of listeners.get(paneId) ?? []) cb();
}

export function getPaneFontSize(paneId: string): number | undefined {
	return sizes.get(paneId);
}

function subscribe(paneId: string, cb: () => void): () => void {
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

/** The pane's drawn font size, or undefined before its terminal exists. */
export function usePaneFontSize(paneId: string): number | undefined {
	return useSyncExternalStore(
		useCallback((cb: () => void) => subscribe(paneId, cb), [paneId]),
		useCallback(() => sizes.get(paneId), [paneId]),
		useCallback(() => sizes.get(paneId), [paneId]),
	);
}

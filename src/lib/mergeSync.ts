/**
 * Which conflict block the user is looking at, published by the result pane and
 * consumed by its Merge side panes.
 *
 * One-directional by design: the result pane drives the sides, never the other
 * way round. The sides are read-only context, so bidirectional sync would only
 * add ways for the two to fight.
 *
 * A plain module registry rather than a store — this is transient view state,
 * never persisted, in the same spirit as `dragPaneStore`.
 */
const activeBlock = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function setActiveConflictBlock(
	sourcePaneId: string,
	blockIndex: number | null,
): void {
	const previous = activeBlock.get(sourcePaneId) ?? null;
	if (previous === blockIndex) return;
	if (blockIndex === null) activeBlock.delete(sourcePaneId);
	else activeBlock.set(sourcePaneId, blockIndex);
	for (const fn of listeners.get(sourcePaneId) ?? []) fn();
}

export function getActiveConflictBlock(sourcePaneId: string): number | null {
	return activeBlock.get(sourcePaneId) ?? null;
}

export function subscribeActiveConflictBlock(
	sourcePaneId: string,
	fn: () => void,
): () => void {
	const set = listeners.get(sourcePaneId) ?? new Set();
	set.add(fn);
	listeners.set(sourcePaneId, set);
	return () => {
		set.delete(fn);
		if (set.size === 0) listeners.delete(sourcePaneId);
	};
}

export function clearActiveConflictBlock(sourcePaneId: string): void {
	activeBlock.delete(sourcePaneId);
	listeners.delete(sourcePaneId);
}

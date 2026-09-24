import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { cycleTile, type GridDirection, gridNeighbour } from "./fleetConsole";

/** Whether the Fleet Console is the view on screen (Statistics covers it). */
export function fleetConsoleShowing(): boolean {
	const s = useWindowUiStore.getState();
	return s.fleetConsoleOpen && !s.statisticsOverlayOpen;
}

/**
 * The pane that pane-scoped commands act on: the **Focused tile** while the
 * Fleet Console is on screen, otherwise the Workspace view's **Focused pane**.
 * Every "act on the focused pane" shortcut resolves its target through here,
 * so none can reach into the hidden Workspace view from the console.
 */
export function targetPaneId(): string | null {
	return fleetConsoleShowing()
		? useWindowUiStore.getState().focusedTileId
		: useWorkspaceStore.getState().focusedPaneId;
}

/** React-side twin of `targetPaneId`. */
export function useTargetPaneId(): string | null {
	const inFleet = useWindowUiStore(
		(s) => s.fleetConsoleOpen && !s.statisticsOverlayOpen,
	);
	const tile = useWindowUiStore((s) => s.focusedTileId);
	const pane = useWorkspaceStore((s) => s.focusedPaneId);
	return inFleet ? tile : pane;
}

/**
 * Wrap a Workspace-view shortcut so it does nothing while the console is on
 * screen: it would change a layout or sidebar the user cannot see.
 */
export function workspaceViewOnly(fn: () => void): () => void {
	return () => {
		if (fleetConsoleShowing()) return;
		fn();
	};
}

// The grid as last drawn: tile order and column count. Published by the
// console so keyboard moves walk exactly what is on screen, including the
// column count Auto resolved from the measured size.
let drawn: { paneIds: string[]; columns: number } = { paneIds: [], columns: 1 };

export function publishFleetGrid(paneIds: string[], columns: number): void {
	drawn = { paneIds, columns };
}

/** **Directional move** in the grid. No wrap. */
export function navigateFleet(dir: GridDirection): void {
	const store = useWindowUiStore.getState();
	const i = drawn.paneIds.indexOf(store.focusedTileId ?? "");
	if (i < 0) {
		if (drawn.paneIds[0]) store.setFocusedTile(drawn.paneIds[0]);
		return;
	}
	const next = gridNeighbour(i, drawn.paneIds.length, drawn.columns, dir);
	if (next !== null) store.setFocusedTile(drawn.paneIds[next]);
}

/** **Pane cycle** in the grid: reading order, wrapping. */
export function cycleFleet(step: 1 | -1): void {
	const store = useWindowUiStore.getState();
	const next = cycleTile(
		drawn.paneIds.map((paneId) => ({ paneId })),
		store.focusedTileId,
		step,
	);
	if (next) store.setFocusedTile(next);
}

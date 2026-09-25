import {
	TILE_ZOOM_DEFAULT,
	TILE_ZOOM_STEP,
	useWindowUiStore,
} from "../stores/windowUiStore";
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

/**
 * Focus a pane because the user acted on it (fired a prompt action at it,
 * dropped a file on it). In the Fleet Console that moves the **Focused tile**;
 * setting the Workspace view's Focused pane there would point the hidden view
 * at a pane that is usually in another Workspace or Tab, and after the
 * Console closes typing and pane shortcuts would land in a terminal nobody
 * can see.
 */
export function focusPaneForInput(paneId: string): void {
	if (fleetConsoleShowing()) {
		useWindowUiStore.getState().setFocusedTile(paneId);
	} else {
		useWorkspaceStore.getState().setFocusedPane(paneId);
	}
}

/** Whether a Fleet tile is actually within the Console's visible area, not
 *  just in the grid: the grid and the Filmstrip both scroll, and a tile
 *  scrolled out of view is as unseen as a pane in a hidden Tab. */
export function isFleetTileOnScreen(paneId: string): boolean {
	if (!isShownAsFleetTile(paneId)) return false;
	if (typeof document === "undefined") return true;
	const tile = [...document.querySelectorAll("[data-fleet-tile]")].find(
		(el) => el.getAttribute("data-fleet-tile") === paneId,
	);
	const area = document.querySelector("[data-fleet-scroll]");
	if (!tile || !area) return true; // not laid out (tests, first frame)
	const t = tile.getBoundingClientRect();
	const a = area.getBoundingClientRect();
	if (a.height === 0 && a.width === 0) return true;
	return (
		t.bottom > a.top && t.top < a.bottom && t.right > a.left && t.left < a.right
	);
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

/** How many tiles the console is drawing. */
export function fleetTileCount(): number {
	return drawn.paneIds.length;
}

/** Whether `paneId` is a Fleet tile on screen right now. */
export function isShownAsFleetTile(paneId: string): boolean {
	return fleetConsoleShowing() && drawn.paneIds.includes(paneId);
}

/** **Directional move** in the grid. No wrap. In **Spotlight** it walks the
 *  Filmstrip: up and down along it, left to the spotlighted tile, right from
 *  the spotlighted tile back into the Filmstrip. */
export function navigateFleet(dir: GridDirection): void {
	const store = useWindowUiStore.getState();
	const spot = store.spotlightTileId;
	if (spot && drawn.paneIds.includes(spot)) {
		const film = drawn.paneIds.filter((id) => id !== spot);
		const at = film.indexOf(store.focusedTileId ?? "");
		if (at < 0) {
			// On the spotlight (or nowhere): only "right" leaves it.
			if (dir === "right" && film[0]) store.setFocusedTile(film[0]);
			return;
		}
		if (dir === "left") store.setFocusedTile(spot);
		else if (dir === "up" && at > 0) store.setFocusedTile(film[at - 1]);
		else if (dir === "down" && at < film.length - 1) {
			store.setFocusedTile(film[at + 1]);
		}
		return;
	}
	const i = drawn.paneIds.indexOf(store.focusedTileId ?? "");
	if (i < 0) {
		if (drawn.paneIds[0]) store.setFocusedTile(drawn.paneIds[0]);
		return;
	}
	const next = gridNeighbour(i, drawn.paneIds.length, drawn.columns, dir);
	if (next !== null) store.setFocusedTile(drawn.paneIds[next]);
}

/** **Pane cycle** in the grid: reading order, wrapping. In **Spotlight** it
 *  moves the spotlight itself to the next or previous agent. */
export function cycleFleet(step: 1 | -1): void {
	const store = useWindowUiStore.getState();
	const spot = store.spotlightTileId;
	if (spot && drawn.paneIds.includes(spot)) {
		const next = cycleTile(
			drawn.paneIds.map((paneId) => ({ paneId })),
			spot,
			step,
		);
		if (next) {
			store.setSpotlight(next);
			store.setFocusedTile(next);
		}
		return;
	}
	const next = cycleTile(
		drawn.paneIds.map((paneId) => ({ paneId })),
		store.focusedTileId,
		step,
	);
	if (next) store.setFocusedTile(next);
}

/** Spotlight the **Focused tile**, or end Spotlight if it is the spotlighted
 *  one. Cmd+Shift+Enter / Ctrl+Shift+Enter. */
export function toggleFleetSpotlight(): void {
	const store = useWindowUiStore.getState();
	const focused = store.focusedTileId;
	if (!focused) return;
	store.setSpotlight(store.spotlightTileId === focused ? null : focused);
}

/** Step the **Tile zoom** by one slider step, or reset it with `0`. */
export function stepTileZoom(direction: 1 | -1 | 0): void {
	const store = useWindowUiStore.getState();
	store.setTileZoom(
		direction === 0
			? TILE_ZOOM_DEFAULT
			: store.fleetGrid.zoom + direction * TILE_ZOOM_STEP,
	);
}

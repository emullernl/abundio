import { create } from "zustand";
import { persist } from "zustand/middleware";
import { currentWindowLabel } from "../lib/appWindow";

/** Per-window UI state — collapse/expand of the left sidebar and the right
 *  sidebar, plus the right sidebar's active tab and PR-section collapsed
 *  state. Persisted to `localStorage` keyed by the window's Tauri label,
 *  so each application Window remembers its own layout independent of any
 *  other Window.
 *
 *  See ADR-0007 (per-Window state) and ADR-0010 (right sidebar as
 *  in-workspace toolbox). */

/** The Fleet Console's grid: a preset of columns × *visible* rows (the row
 *  count sets tile height; more agents add rows and the grid scrolls), plus
 *  the divider positions. `null` ratios mean equal sizes. */
export interface FleetGrid {
	preset: "auto" | { columns: number; rows: number };
	colRatios: number[] | null;
	rowRatios: number[] | null;
	/** **Tile zoom**: tiles draw at the terminal font size times this. */
	zoom: number;
	/** The **Filmstrip**'s share of the width in **Spotlight**. */
	filmstripRatio: number;
}

export const TILE_ZOOM_DEFAULT = 0.75;
export const TILE_ZOOM_MIN = 0.5;
export const TILE_ZOOM_MAX = 1;
export const TILE_ZOOM_STEP = 0.05;
export const FILMSTRIP_DEFAULT = 1 / 3;

/** Clamp to the slider's range and snap to its steps. */
export function clampTileZoom(z: number): number {
	const snapped = Math.round(z / TILE_ZOOM_STEP) * TILE_ZOOM_STEP;
	return Math.min(TILE_ZOOM_MAX, Math.max(TILE_ZOOM_MIN, +snapped.toFixed(2)));
}

const DEFAULT_FLEET_GRID: FleetGrid = {
	preset: "auto",
	colRatios: null,
	rowRatios: null,
	zoom: TILE_ZOOM_DEFAULT,
	filmstripRatio: FILMSTRIP_DEFAULT,
};

export interface AddWorktreeRequest {
	workspaceId: string;
	agentId?: string;
	background?: boolean;
}

export type RightSidebarTab = "git" | "explorer" | "search" | "notes";

interface WindowUiState {
	sidebarCollapsed: boolean;
	rightSidebarOpen: boolean;
	rightSidebarActiveTab: RightSidebarTab;
	prSectionCollapsed: boolean;
	/** The **Commits** Anchored section's collapse state. */
	commitsSectionCollapsed: boolean;

	toggleSidebar: () => void;
	setSidebarCollapsed: (collapsed: boolean) => void;
	toggleRightSidebar: () => void;
	setRightSidebarOpen: (open: boolean) => void;
	setRightSidebarActiveTab: (tab: RightSidebarTab) => void;
	/** Smart toggle: if the sidebar is open and `tab` is already active, close
	 *  it; otherwise open the sidebar and switch to `tab`. This powers the
	 *  Cmd+Shift+G/E/F shortcuts so the same key both opens-and-switches and
	 *  closes when pressed again on the active tab. */
	toggleRightSidebarTab: (tab: RightSidebarTab) => void;
	togglePrSectionCollapsed: () => void;
	setPrSectionCollapsed: (collapsed: boolean) => void;
	toggleCommitsSectionCollapsed: () => void;

	/** Worktree sets whose Linked worktree rows are hidden in the Left sidebar
	 *  — **Folded sets**. Keyed by the set's git-derived `worktreeGroupKey`
	 *  (never a Workspace id: grouping itself is derived from git, see
	 *  ADR-0017). Per-Window like the sidebars, so two Windows showing the same
	 *  repository may disagree. Keys are never pruned: a key whose group is not
	 *  currently a rendered set simply has no effect, which is also what makes
	 *  the async git-facts window at launch a non-event. Deliberately *not*
	 *  called "collapsed" — that word means the sidebar itself is narrow. */
	foldedSetKeys: string[];
	toggleSetFolded: (groupKey: string) => void;
	setSetFolded: (groupKey: string, folded: boolean) => void;

	/** The Statistics overlay covers the workspace stack (terminals stay alive
	 *  behind it via the portal registry) and shows agent Turn stats for this
	 *  Window's Active profile. Per-Window, like the sidebars. See ADR-0018. */
	statisticsOverlayOpen: boolean;
	toggleStatisticsOverlay: () => void;
	setStatisticsOverlayOpen: (open: boolean) => void;
	/** The **Fleet Console** replaces everything between the Overview bar and
	 *  the Status bar with a grid of this Window's agent-mode panes. Not
	 *  persisted: every launch opens in the Workspace view. It and the
	 *  Statistics overlay are mutually exclusive on screen: opening Statistics
	 *  covers the console, and closing Statistics reveals it again, while
	 *  opening the console closes Statistics. See ADR-0040. */
	fleetConsoleOpen: boolean;
	toggleFleetConsole: () => void;
	setFleetConsoleOpen: (open: boolean) => void;
	/** The **Focused tile**: the console's own focus, separate from the
	 *  Workspace view's `focusedPaneId` so moving around the grid never
	 *  rearranges the view behind it. Not persisted. */
	focusedTileId: string | null;
	setFocusedTile: (paneId: string | null) => void;
	/** A pane the console has just started an Agent in. It becomes the Focused
	 *  tile now, and the console keeps it focused while its PTY is still on its
	 *  way into agent mode rather than reassigning focus to a neighbour. */
	pendingTile: { paneId: string; at: number } | null;
	expectFleetTile: (paneId: string) => void;
	/** Remembered per Window: two monitors want different grids. */
	fleetGrid: FleetGrid;
	/** Choosing a preset resets the dividers to equal sizes. */
	setFleetPreset: (preset: FleetGrid["preset"]) => void;
	setFleetRatios: (
		colRatios: number[] | null,
		rowRatios: number[] | null,
	) => void;
	setTileZoom: (zoom: number) => void;
	setFilmstripRatio: (ratio: number) => void;
	/** The tile in **Spotlight**, or null for the grid. Kept across closing
	 *  and reopening the Console within a session, so Switch to and back
	 *  resumes where the user was; not persisted across launches. */
	spotlightTileId: string | null;
	/** The grid's scroll position when the Console last closed, restored when
	 *  it reopens. Session-only, like the spotlight. */
	fleetScrollTop: number;
	setSpotlight: (paneId: string | null) => void;
	/** A pending request, from the keyboard shortcut or the Fleet Console's
	 *  New agent, to open the Add worktree dialog for this main-worktree
	 *  Workspace. The Left sidebar owns the dialog (it stays mounted while the
	 *  console hides it), so it takes the request and clears it. `agentId`
	 *  pre-selects the Agent; `background` opens the new Workspace without
	 *  making it Active. Not persisted. */
	addWorktreeRequest: AddWorktreeRequest | null;
	requestAddWorktree: (
		workspaceId: string,
		opts?: { agentId?: string; background?: boolean },
	) => void;
	clearAddWorktreeRequest: () => void;
}

const persistKey = `abundio-window-ui-${currentWindowLabel()}`;

export const useWindowUiStore = create<WindowUiState>()(
	persist(
		(set, get) => ({
			sidebarCollapsed: false,
			rightSidebarOpen: false,
			rightSidebarActiveTab: "git",
			prSectionCollapsed: false,
			commitsSectionCollapsed: false,
			toggleSidebar: () =>
				set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
			setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
			toggleRightSidebar: () =>
				set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
			setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
			setRightSidebarActiveTab: (rightSidebarActiveTab) =>
				set({ rightSidebarActiveTab }),
			toggleRightSidebarTab: (tab) => {
				const s = get();
				if (s.rightSidebarOpen && s.rightSidebarActiveTab === tab) {
					set({ rightSidebarOpen: false });
				} else {
					set({ rightSidebarOpen: true, rightSidebarActiveTab: tab });
				}
			},
			togglePrSectionCollapsed: () =>
				set((s) => ({ prSectionCollapsed: !s.prSectionCollapsed })),
			setPrSectionCollapsed: (collapsed) =>
				set({ prSectionCollapsed: collapsed }),
			toggleCommitsSectionCollapsed: () =>
				set((s) => ({ commitsSectionCollapsed: !s.commitsSectionCollapsed })),
			foldedSetKeys: [],
			toggleSetFolded: (groupKey) =>
				set((s) => ({
					foldedSetKeys: s.foldedSetKeys.includes(groupKey)
						? s.foldedSetKeys.filter((k) => k !== groupKey)
						: [...s.foldedSetKeys, groupKey],
				})),
			setSetFolded: (groupKey, folded) =>
				set((s) => {
					const has = s.foldedSetKeys.includes(groupKey);
					if (has === folded) return s;
					return {
						foldedSetKeys: folded
							? [...s.foldedSetKeys, groupKey]
							: s.foldedSetKeys.filter((k) => k !== groupKey),
					};
				}),
			statisticsOverlayOpen: false,
			toggleStatisticsOverlay: () =>
				set((s) => ({ statisticsOverlayOpen: !s.statisticsOverlayOpen })),
			setStatisticsOverlayOpen: (open) => set({ statisticsOverlayOpen: open }),
			fleetConsoleOpen: false,
			toggleFleetConsole: () => {
				const s = get();
				// The button reads "show the console" while Statistics covers it.
				if (s.statisticsOverlayOpen) {
					set({ statisticsOverlayOpen: false, fleetConsoleOpen: true });
				} else if (s.fleetConsoleOpen) {
					set({ fleetConsoleOpen: false });
				} else {
					set({ fleetConsoleOpen: true });
				}
			},
			focusedTileId: null,
			setFocusedTile: (paneId) => set({ focusedTileId: paneId }),
			pendingTile: null,
			expectFleetTile: (paneId) =>
				set({
					focusedTileId: paneId,
					pendingTile: { paneId, at: Date.now() },
				}),
			fleetGrid: DEFAULT_FLEET_GRID,
			// Choosing a grid size is a request for the grid: it ends Spotlight.
			setFleetPreset: (preset) =>
				set((s) => ({
					fleetGrid: {
						...s.fleetGrid,
						preset,
						colRatios: null,
						rowRatios: null,
					},
					spotlightTileId: null,
				})),
			setTileZoom: (zoom) =>
				set((s) => ({
					fleetGrid: { ...s.fleetGrid, zoom: clampTileZoom(zoom) },
				})),
			setFilmstripRatio: (ratio) =>
				set((s) => ({
					fleetGrid: {
						...s.fleetGrid,
						filmstripRatio: Math.min(0.5, Math.max(0.12, ratio)),
					},
				})),
			spotlightTileId: null,
			fleetScrollTop: 0,
			setSpotlight: (paneId) => set({ spotlightTileId: paneId }),
			setFleetRatios: (colRatios, rowRatios) =>
				set((s) => ({ fleetGrid: { ...s.fleetGrid, colRatios, rowRatios } })),
			setFleetConsoleOpen: (open) =>
				set(
					open
						? { fleetConsoleOpen: true, statisticsOverlayOpen: false }
						: { fleetConsoleOpen: false },
				),
			addWorktreeRequest: null,
			requestAddWorktree: (workspaceId, opts) =>
				set({ addWorktreeRequest: { workspaceId, ...opts } }),
			clearAddWorktreeRequest: () => set({ addWorktreeRequest: null }),
		}),
		{
			name: persistKey,
			version: 2,
			// biome-ignore lint/suspicious/noExplicitAny: persisted shape is opaque pre-migration
			migrate: (persistedState: any, version: number) => {
				if (!persistedState) return persistedState;
				let state = persistedState as Record<string, unknown>;
				// v1: gitPanelOpen → rightSidebarOpen (see ADR-0010).
				if (version < 1) {
					if (typeof state.gitPanelOpen === "boolean") {
						state = { ...state, rightSidebarOpen: state.gitPanelOpen };
					}
					const { gitPanelOpen: _drop, ...rest } = state;
					state = rest;
				}
				// v2: the Filmstrip default widened from 25% to a third. A stored
				// 0.25 is the old default, never dragged, so it follows the new one.
				if (version < 2) {
					const grid = state.fleetGrid as
						| { filmstripRatio?: number }
						| undefined;
					if (grid?.filmstripRatio === 0.25) {
						state = {
							...state,
							fleetGrid: { ...grid, filmstripRatio: FILMSTRIP_DEFAULT },
						};
					}
				}
				return state;
			},
			// Fill fields a stored grid predates (zoom, filmstrip), rather than
			// letting the shallow default merge drop them.
			merge: (persisted, current) => {
				const p = (persisted ?? {}) as Partial<WindowUiState>;
				return {
					...current,
					...p,
					fleetGrid: { ...DEFAULT_FLEET_GRID, ...(p.fleetGrid ?? {}) },
				};
			},
			partialize: (s) => ({
				sidebarCollapsed: s.sidebarCollapsed,
				rightSidebarOpen: s.rightSidebarOpen,
				rightSidebarActiveTab: s.rightSidebarActiveTab,
				prSectionCollapsed: s.prSectionCollapsed,
				commitsSectionCollapsed: s.commitsSectionCollapsed,
				statisticsOverlayOpen: s.statisticsOverlayOpen,
				foldedSetKeys: s.foldedSetKeys,
				fleetGrid: s.fleetGrid,
			}),
		},
	),
);

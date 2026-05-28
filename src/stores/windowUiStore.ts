import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Per-window UI state — collapse/expand of the left sidebar and the right
 *  sidebar, plus the right sidebar's active tab and PR-section collapsed
 *  state. Persisted to `localStorage` keyed by the window's Tauri label,
 *  so each application Window remembers its own layout independent of any
 *  other Window.
 *
 *  See ADR-0007 (per-Window state) and ADR-0010 (right sidebar as
 *  in-workspace toolbox). */

export type RightSidebarTab = "git" | "explorer" | "search";

interface WindowUiState {
	sidebarCollapsed: boolean;
	rightSidebarOpen: boolean;
	rightSidebarActiveTab: RightSidebarTab;
	prSectionCollapsed: boolean;

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
}

/** Synchronously resolved window label. Falls back to "main" when running
 *  outside Tauri (jsdom tests, SSR) so we still get a working store. */
function currentWindowLabel(): string {
	try {
		return getCurrentWindow().label;
	} catch {
		return "main";
	}
}

const persistKey = `abundio-window-ui-${currentWindowLabel()}`;

export const useWindowUiStore = create<WindowUiState>()(
	persist(
		(set, get) => ({
			sidebarCollapsed: false,
			rightSidebarOpen: false,
			rightSidebarActiveTab: "git",
			prSectionCollapsed: false,
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
		}),
		{
			name: persistKey,
			version: 1,
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
				return state;
			},
			partialize: (s) => ({
				sidebarCollapsed: s.sidebarCollapsed,
				rightSidebarOpen: s.rightSidebarOpen,
				rightSidebarActiveTab: s.rightSidebarActiveTab,
				prSectionCollapsed: s.prSectionCollapsed,
			}),
		},
	),
);

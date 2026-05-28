import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Per-window UI state — collapse/expand of the left sidebar and the right
 *  git panel. Persisted to `localStorage` keyed by the window's Tauri label,
 *  so each application Window remembers its own layout independent of any
 *  other Window.
 *
 *  The label is read once at module load via `getCurrentWindow().label`.
 *  Each window has its own JS context (separate localStorage origin sharing
 *  but a separate zustand instance), so the persist `name` is unique per
 *  window even though localStorage is one shared keystore.
 *
 *  See ADR-0007: window-scoped state belongs here; profile-scoped state
 *  lives in profileStore; truly global state (theme, fonts) stays in
 *  settingsStore. */

interface WindowUiState {
	sidebarCollapsed: boolean;
	gitPanelOpen: boolean;

	toggleSidebar: () => void;
	setSidebarCollapsed: (collapsed: boolean) => void;
	toggleGitPanel: () => void;
	setGitPanelOpen: (open: boolean) => void;
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
		(set) => ({
			sidebarCollapsed: false,
			gitPanelOpen: false,
			toggleSidebar: () =>
				set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
			setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
			toggleGitPanel: () => set((s) => ({ gitPanelOpen: !s.gitPanelOpen })),
			setGitPanelOpen: (open) => set({ gitPanelOpen: open }),
		}),
		{
			name: persistKey,
			partialize: (s) => ({
				sidebarCollapsed: s.sidebarCollapsed,
				gitPanelOpen: s.gitPanelOpen,
			}),
		},
	),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, getTheme } from "../lib/themes";
import { setAllTerminalsTheme } from "../lib/terminalManager";

interface SettingsState {
	fontFamily: string;
	fontSize: number;
	theme: string;
	sidebarCollapsed: boolean;
	sidebarSplitRatio: number;

	setFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	toggleSidebar: () => void;
	setSidebarSplitRatio: (ratio: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			fontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
			fontSize: 14,
			theme: "default",
			sidebarCollapsed: false,
			sidebarSplitRatio: 0.4,

			setFontFamily: (fontFamily) => set({ fontFamily }),
			setFontSize: (fontSize) => set({ fontSize }),
			setTheme: (themeName) => {
				const fullTheme = getTheme(themeName);
				applyTheme(fullTheme);
				setAllTerminalsTheme(fullTheme.terminal);
				set({ theme: themeName });
			},
			toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
			setSidebarSplitRatio: (sidebarSplitRatio) => set({ sidebarSplitRatio }),
		}),
		{
			name: "abundio-settings",
			partialize: (state) => ({ fontSize: state.fontSize, theme: state.theme, sidebarSplitRatio: state.sidebarSplitRatio }),
		},
	),
);

// Apply the persisted theme immediately on load by reading localStorage directly.
// Zustand's persist middleware rehydrates asynchronously (microtask), which is too late
// for CSS variables — the UI would flash the default theme first.
{
	let themeName = "default";
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed?.state?.theme) {
				themeName = parsed.state.theme;
			}
		}
	} catch {
		// Fall back to default
	}
	applyTheme(getTheme(themeName));
}

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, getTheme } from "../lib/themes";

interface SettingsState {
	fontFamily: string;
	fontSize: number;
	theme: string;
	sidebarCollapsed: boolean;

	setFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	toggleSidebar: () => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			fontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
			fontSize: 14,
			theme: "default",
			sidebarCollapsed: false,

			setFontFamily: (fontFamily) => set({ fontFamily }),
			setFontSize: (fontSize) => set({ fontSize }),
			setTheme: (themeName) => {
				applyTheme(getTheme(themeName));
				set({ theme: themeName });
			},
			toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
		}),
		{
			name: "abundio-settings",
			partialize: (state) => ({ fontSize: state.fontSize, theme: state.theme }),
		},
	),
);

// Apply default theme on load
applyTheme(getTheme("default"));

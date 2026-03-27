import { create } from "zustand";

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

export const useSettingsStore = create<SettingsState>((set) => ({
	fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
	fontSize: 14,
	theme: "default",
	sidebarCollapsed: false,

	setFontFamily: (fontFamily) => set({ fontFamily }),
	setFontSize: (fontSize) => set({ fontSize }),
	setTheme: (theme) => set({ theme }),
	toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));

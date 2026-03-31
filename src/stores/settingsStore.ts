import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, getTheme } from "../lib/themes";
import { setAllTerminalsTheme, setActivityByteThreshold as setTerminalActivityByteThreshold } from "../lib/terminalManager";

interface SettingsState {
	fontFamily: string;
	fontSize: number;
	theme: string;
	sidebarCollapsed: boolean;
	sidebarSplitRatio: number;
	gitPanelWidth: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;

	setFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	toggleSidebar: () => void;
	setSidebarSplitRatio: (ratio: number) => void;
	setGitPanelWidth: (width: number) => void;
	toggleDebugActivityMeter: () => void;
	setActivityByteThreshold: (n: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			fontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
			fontSize: 14,
			theme: "default",
			sidebarCollapsed: false,
			sidebarSplitRatio: 0.4,
			gitPanelWidth: 360,
			debugActivityMeter: false,
			activityByteThreshold: 512,

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
			setGitPanelWidth: (gitPanelWidth) => set({ gitPanelWidth }),
			toggleDebugActivityMeter: () => set((state) => ({ debugActivityMeter: !state.debugActivityMeter })),
			setActivityByteThreshold: (n) => {
				setTerminalActivityByteThreshold(n);
				set({ activityByteThreshold: n });
			},
		}),
		{
			name: "abundio-settings",
			partialize: (state) => ({ fontSize: state.fontSize, theme: state.theme, sidebarSplitRatio: state.sidebarSplitRatio, gitPanelWidth: state.gitPanelWidth, debugActivityMeter: state.debugActivityMeter, activityByteThreshold: state.activityByteThreshold }),
			onRehydrateStorage: () => (state) => {
				if (state?.activityByteThreshold != null) {
					setTerminalActivityByteThreshold(state.activityByteThreshold);
				}
			},
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

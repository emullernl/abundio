import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_AGENTS, mergeAgentsWithBuiltins } from "../lib/agents";
import {
	setAllTerminalsFontFamily,
	setAllTerminalsTheme,
	setActivityByteThreshold as setTerminalActivityByteThreshold,
} from "../lib/terminalManager";
import { applyTheme, getTheme } from "../lib/themes";
import type { CodingAgent } from "../lib/types";

interface SettingsState {
	terminalFontFamily: string;
	uiFontFamily: string;
	fontSize: number;
	uiFontSize: number;
	theme: string;
	sidebarCollapsed: boolean;
	sidebarSplitRatio: number;
	gitPanelWidth: number;
	gitPanelSplitRatio: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;
	agents: CodingAgent[];

	setTerminalFontFamily: (font: string) => void;
	setUiFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setUiFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	toggleSidebar: () => void;
	setSidebarSplitRatio: (ratio: number) => void;
	setGitPanelWidth: (width: number) => void;
	setGitPanelSplitRatio: (ratio: number) => void;
	toggleDebugActivityMeter: () => void;
	setActivityByteThreshold: (n: number) => void;
	addAgent: (name: string, command: string, args?: string[]) => void;
	removeAgent: (id: string) => void;
	toggleAgent: (id: string) => void;
	updateAgent: (
		id: string,
		updates: Partial<Pick<CodingAgent, "name" | "command" | "args">>,
	) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
			uiFontFamily: "system-ui, -apple-system, sans-serif",
			fontSize: 14,
			uiFontSize: 14,
			theme: "default",
			sidebarCollapsed: false,
			sidebarSplitRatio: 0.4,
			gitPanelWidth: 360,
			gitPanelSplitRatio: 0.5,
			debugActivityMeter: false,
			activityByteThreshold: 512,
			agents: BUILTIN_AGENTS,

			setTerminalFontFamily: (terminalFontFamily) => {
				document.documentElement.style.setProperty(
					"--font-mono",
					terminalFontFamily,
				);
				setAllTerminalsFontFamily(terminalFontFamily);
				set({ terminalFontFamily });
			},
			setUiFontFamily: (uiFontFamily) => {
				document.documentElement.style.setProperty("--font-ui", uiFontFamily);
				set({ uiFontFamily });
			},
			setFontSize: (fontSize) => set({ fontSize }),
			setUiFontSize: (uiFontSize) => {
				document.documentElement.style.setProperty(
					"--ui-font-size",
					`${uiFontSize}px`,
				);
				set({ uiFontSize });
			},
			setTheme: (themeName) => {
				const fullTheme = getTheme(themeName);
				applyTheme(fullTheme);
				setAllTerminalsTheme(fullTheme.terminal);
				set({ theme: themeName });
			},
			toggleSidebar: () =>
				set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
			setSidebarSplitRatio: (sidebarSplitRatio) => set({ sidebarSplitRatio }),
			setGitPanelWidth: (gitPanelWidth) => set({ gitPanelWidth }),
			setGitPanelSplitRatio: (gitPanelSplitRatio) =>
				set({ gitPanelSplitRatio }),
			toggleDebugActivityMeter: () =>
				set((state) => ({ debugActivityMeter: !state.debugActivityMeter })),
			setActivityByteThreshold: (n) => {
				setTerminalActivityByteThreshold(n);
				set({ activityByteThreshold: n });
			},
			addAgent: (name, command, args) => {
				const id = `custom-${crypto.randomUUID()}`;
				set((s) => ({
					agents: [
						...s.agents,
						{ id, name, command, args, builtin: false, enabled: true },
					],
				}));
			},
			removeAgent: (id) => {
				set((s) => ({
					agents: s.agents.filter((a) => a.id !== id || a.builtin),
				}));
			},
			toggleAgent: (id) => {
				set((s) => ({
					agents: s.agents.map((a) =>
						a.id === id ? { ...a, enabled: !a.enabled } : a,
					),
				}));
			},
			updateAgent: (id, updates) => {
				set((s) => ({
					agents: s.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
				}));
			},
		}),
		{
			name: "abundio-settings",
			partialize: (state) => ({
				terminalFontFamily: state.terminalFontFamily,
				uiFontFamily: state.uiFontFamily,
				fontSize: state.fontSize,
				uiFontSize: state.uiFontSize,
				theme: state.theme,
				sidebarSplitRatio: state.sidebarSplitRatio,
				gitPanelWidth: state.gitPanelWidth,
				gitPanelSplitRatio: state.gitPanelSplitRatio,
				debugActivityMeter: state.debugActivityMeter,
				activityByteThreshold: state.activityByteThreshold,
				agents: state.agents,
			}),
			onRehydrateStorage: () => (state) => {
				if (state?.activityByteThreshold != null) {
					setTerminalActivityByteThreshold(state.activityByteThreshold);
				}
				if (state?.agents) {
					state.agents = mergeAgentsWithBuiltins(state.agents);
				}
			},
		},
	),
);

// Apply the persisted theme and fonts immediately on load by reading localStorage directly.
// Zustand's persist middleware rehydrates asynchronously (microtask), which is too late
// for CSS variables — the UI would flash the default theme/font first.
{
	let themeName = "default";
	let uiFont: string | null = null;
	let termFont: string | null = null;
	let uiFontSizeVal: number | null = null;
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed?.state?.theme) {
				themeName = parsed.state.theme;
			}
			if (parsed?.state?.uiFontFamily) {
				uiFont = parsed.state.uiFontFamily;
			}
			if (parsed?.state?.terminalFontFamily) {
				termFont = parsed.state.terminalFontFamily;
			}
			if (parsed?.state?.uiFontSize) {
				uiFontSizeVal = parsed.state.uiFontSize;
			}
		}
	} catch {
		// Fall back to defaults
	}
	applyTheme(getTheme(themeName));
	if (uiFont) {
		document.documentElement.style.setProperty("--font-ui", uiFont);
	}
	if (termFont) {
		document.documentElement.style.setProperty("--font-mono", termFont);
	}
	if (uiFontSizeVal) {
		document.documentElement.style.setProperty(
			"--ui-font-size",
			`${uiFontSizeVal}px`,
		);
	}
}

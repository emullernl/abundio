import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_AGENTS, mergeAgentsWithBuiltins } from "../lib/agents";
import { agentHooks } from "../lib/ipc";
import {
	setAllTerminalsFontFamily,
	setAllTerminalsFontSize,
	setAllTerminalsScrollback,
	setAllTerminalsTheme,
	setActivityByteThreshold as setTerminalActivityByteThreshold,
	setWebglEnabled,
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
	sidebarWidth: number;
	sidebarSplitRatio: number;
	gitPanelWidth: number;
	gitPanelSplitRatio: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;
	terminalScrollback: number;
	shellPath: string | null;
	agents: CodingAgent[];
	sidebarBottomPanel: "explorer" | "search";
	lastOpenedDevEnvId: string | null;
	editorWordWrap: boolean;
	markdownPreviewAutoOpen: boolean;
	agentHooksEnabled: boolean;
	gpuAccelerationEnabled: boolean;

	setShellPath: (path: string | null) => void;
	setTerminalFontFamily: (font: string) => void;
	setUiFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setUiFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	toggleSidebar: () => void;
	setSidebarWidth: (width: number) => void;
	setSidebarSplitRatio: (ratio: number) => void;
	setGitPanelWidth: (width: number) => void;
	setGitPanelSplitRatio: (ratio: number) => void;
	toggleDebugActivityMeter: () => void;
	setActivityByteThreshold: (n: number) => void;
	setTerminalScrollback: (n: number) => void;
	addAgent: (name: string, command: string, args?: string[]) => void;
	removeAgent: (id: string) => void;
	toggleAgent: (id: string) => void;
	updateAgent: (
		id: string,
		updates: Partial<Pick<CodingAgent, "name" | "command" | "args">>,
	) => void;
	setSidebarBottomPanel: (panel: "explorer" | "search") => void;
	setLastOpenedDevEnvId: (id: string) => void;
	toggleEditorWordWrap: () => void;
	toggleMarkdownPreviewAutoOpen: () => void;
	setAgentHooksEnabled: (enabled: boolean) => void;
	setGpuAcceleration: (enabled: boolean) => void;
}

// Read persisted settings from localStorage synchronously so the store's
// initial state matches the user's chosen values from the very first render.
// Zustand `persist` rehydrates asynchronously (microtask), and any consumer
// that calls `useSettingsStore.getState()` during that window would otherwise
// read the hardcoded defaults — most visibly causing terminals to briefly
// rasterize against the default font before settling on the configured one.
const PERSISTED_DEFAULTS: {
	terminalFontFamily: string;
	uiFontFamily: string;
	fontSize: number;
	uiFontSize: number;
	theme: string;
	sidebarWidth: number;
	sidebarSplitRatio: number;
	gitPanelWidth: number;
	gitPanelSplitRatio: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;
	terminalScrollback: number;
	shellPath: string | null;
	agents: CodingAgent[];
	lastOpenedDevEnvId: string | null;
	editorWordWrap: boolean;
	markdownPreviewAutoOpen: boolean;
	agentHooksEnabled: boolean;
	gpuAccelerationEnabled: boolean;
} = (() => {
	const defaults = {
		terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		uiFontFamily: "system-ui, -apple-system, sans-serif",
		fontSize: 14,
		uiFontSize: 14,
		theme: "default",
		sidebarWidth: 280,
		sidebarSplitRatio: 0.4,
		gitPanelWidth: 360,
		gitPanelSplitRatio: 0.5,
		debugActivityMeter: false,
		activityByteThreshold: 1024,
		terminalScrollback: 1000,
		shellPath: null as string | null,
		agents: BUILTIN_AGENTS as CodingAgent[],
		lastOpenedDevEnvId: null as string | null,
		editorWordWrap: true,
		markdownPreviewAutoOpen: true,
		agentHooksEnabled: false,
		gpuAccelerationEnabled: true,
	};
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (!raw) return defaults;
		const parsed = JSON.parse(raw);
		const s = parsed?.state;
		if (!s) return defaults;
		return {
			terminalFontFamily:
				typeof s.terminalFontFamily === "string"
					? s.terminalFontFamily
					: defaults.terminalFontFamily,
			uiFontFamily:
				typeof s.uiFontFamily === "string"
					? s.uiFontFamily
					: defaults.uiFontFamily,
			fontSize: typeof s.fontSize === "number" ? s.fontSize : defaults.fontSize,
			uiFontSize:
				typeof s.uiFontSize === "number" ? s.uiFontSize : defaults.uiFontSize,
			theme: typeof s.theme === "string" ? s.theme : defaults.theme,
			sidebarWidth:
				typeof s.sidebarWidth === "number"
					? s.sidebarWidth
					: defaults.sidebarWidth,
			sidebarSplitRatio:
				typeof s.sidebarSplitRatio === "number"
					? s.sidebarSplitRatio
					: defaults.sidebarSplitRatio,
			gitPanelWidth:
				typeof s.gitPanelWidth === "number"
					? s.gitPanelWidth
					: defaults.gitPanelWidth,
			gitPanelSplitRatio:
				typeof s.gitPanelSplitRatio === "number"
					? s.gitPanelSplitRatio
					: defaults.gitPanelSplitRatio,
			debugActivityMeter:
				typeof s.debugActivityMeter === "boolean"
					? s.debugActivityMeter
					: defaults.debugActivityMeter,
			activityByteThreshold:
				typeof s.activityByteThreshold === "number"
					? // Migrate the previous default (512) up to the new default (1024).
						// Custom values are preserved.
						s.activityByteThreshold === 512
						? 1024
						: s.activityByteThreshold
					: defaults.activityByteThreshold,
			terminalScrollback:
				typeof s.terminalScrollback === "number"
					? s.terminalScrollback
					: defaults.terminalScrollback,
			shellPath:
				typeof s.shellPath === "string" || s.shellPath === null
					? s.shellPath
					: defaults.shellPath,
			agents: Array.isArray(s.agents)
				? mergeAgentsWithBuiltins(s.agents)
				: defaults.agents,
			lastOpenedDevEnvId:
				typeof s.lastOpenedDevEnvId === "string"
					? s.lastOpenedDevEnvId
					: defaults.lastOpenedDevEnvId,
			editorWordWrap:
				typeof s.editorWordWrap === "boolean"
					? s.editorWordWrap
					: defaults.editorWordWrap,
			markdownPreviewAutoOpen:
				typeof s.markdownPreviewAutoOpen === "boolean"
					? s.markdownPreviewAutoOpen
					: defaults.markdownPreviewAutoOpen,
			agentHooksEnabled:
				typeof s.agentHooksEnabled === "boolean"
					? s.agentHooksEnabled
					: defaults.agentHooksEnabled,
			gpuAccelerationEnabled:
				typeof s.gpuAccelerationEnabled === "boolean"
					? s.gpuAccelerationEnabled
					: defaults.gpuAccelerationEnabled,
		};
	} catch {
		return defaults;
	}
})();

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			terminalFontFamily: PERSISTED_DEFAULTS.terminalFontFamily,
			uiFontFamily: PERSISTED_DEFAULTS.uiFontFamily,
			fontSize: PERSISTED_DEFAULTS.fontSize,
			uiFontSize: PERSISTED_DEFAULTS.uiFontSize,
			theme: PERSISTED_DEFAULTS.theme,
			sidebarCollapsed: false,
			sidebarWidth: PERSISTED_DEFAULTS.sidebarWidth,
			sidebarSplitRatio: PERSISTED_DEFAULTS.sidebarSplitRatio,
			gitPanelWidth: PERSISTED_DEFAULTS.gitPanelWidth,
			gitPanelSplitRatio: PERSISTED_DEFAULTS.gitPanelSplitRatio,
			debugActivityMeter: PERSISTED_DEFAULTS.debugActivityMeter,
			activityByteThreshold: PERSISTED_DEFAULTS.activityByteThreshold,
			terminalScrollback: PERSISTED_DEFAULTS.terminalScrollback,
			shellPath: PERSISTED_DEFAULTS.shellPath,
			agents: PERSISTED_DEFAULTS.agents,
			sidebarBottomPanel: "explorer",
			lastOpenedDevEnvId: PERSISTED_DEFAULTS.lastOpenedDevEnvId,
			editorWordWrap: PERSISTED_DEFAULTS.editorWordWrap,
			markdownPreviewAutoOpen: PERSISTED_DEFAULTS.markdownPreviewAutoOpen,
			agentHooksEnabled: PERSISTED_DEFAULTS.agentHooksEnabled,
			gpuAccelerationEnabled: PERSISTED_DEFAULTS.gpuAccelerationEnabled,

			setShellPath: (shellPath) => set({ shellPath }),
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
			setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
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
			setTerminalScrollback: (n) => {
				setAllTerminalsScrollback(n);
				set({ terminalScrollback: n });
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
			setSidebarBottomPanel: (sidebarBottomPanel) =>
				set({ sidebarBottomPanel }),
			setLastOpenedDevEnvId: (id) => set({ lastOpenedDevEnvId: id }),
			toggleEditorWordWrap: () =>
				set((s) => ({ editorWordWrap: !s.editorWordWrap })),
			toggleMarkdownPreviewAutoOpen: () =>
				set((s) => ({
					markdownPreviewAutoOpen: !s.markdownPreviewAutoOpen,
				})),
			setAgentHooksEnabled: (agentHooksEnabled) => {
				// Provision/unprovision agent hook configs to match the setting.
				agentHooks.provision(agentHooksEnabled).catch(() => {});
				set({ agentHooksEnabled });
			},
			setGpuAcceleration: (gpuAccelerationEnabled) => {
				setWebglEnabled(gpuAccelerationEnabled);
				set({ gpuAccelerationEnabled });
			},
		}),
		{
			name: "abundio-settings",
			version: 1,
			// biome-ignore lint/suspicious/noExplicitAny: persisted shape is opaque pre-migration
			migrate: (persistedState: any, version: number) => {
				if (!persistedState) return persistedState;
				if (version < 1 && persistedState.activityByteThreshold === 512) {
					return { ...persistedState, activityByteThreshold: 1024 };
				}
				return persistedState;
			},
			partialize: (state) => ({
				terminalFontFamily: state.terminalFontFamily,
				uiFontFamily: state.uiFontFamily,
				fontSize: state.fontSize,
				uiFontSize: state.uiFontSize,
				theme: state.theme,
				sidebarWidth: state.sidebarWidth,
				sidebarSplitRatio: state.sidebarSplitRatio,
				gitPanelWidth: state.gitPanelWidth,
				gitPanelSplitRatio: state.gitPanelSplitRatio,
				debugActivityMeter: state.debugActivityMeter,
				activityByteThreshold: state.activityByteThreshold,
				terminalScrollback: state.terminalScrollback,
				shellPath: state.shellPath,
				agents: state.agents,
				lastOpenedDevEnvId: state.lastOpenedDevEnvId,
				editorWordWrap: state.editorWordWrap,
				markdownPreviewAutoOpen: state.markdownPreviewAutoOpen,
				agentHooksEnabled: state.agentHooksEnabled,
				gpuAccelerationEnabled: state.gpuAccelerationEnabled,
			}),
			// Merge persisted state into current state. Applied during rehydration
			// so new builtins (agents, etc.) added in app updates are always present
			// even when localStorage has an older snapshot without them.
			// biome-ignore lint/suspicious/noExplicitAny: persisted shape is opaque
			merge: (persistedState: any, currentState) => ({
				...currentState,
				...persistedState,
				agents: Array.isArray(persistedState?.agents)
					? mergeAgentsWithBuiltins(persistedState.agents)
					: currentState.agents,
			}),
			onRehydrateStorage: () => (state) => {
				if (state?.activityByteThreshold != null) {
					setTerminalActivityByteThreshold(state.activityByteThreshold);
				}
				if (state?.terminalScrollback != null) {
					setAllTerminalsScrollback(state.terminalScrollback);
				}
				// Fix race: terminals created before rehydration have default font/theme.
				if (state?.terminalFontFamily) {
					setAllTerminalsFontFamily(state.terminalFontFamily);
				}
				if (state?.fontSize) {
					setAllTerminalsFontSize(state.fontSize);
				}
				if (state?.theme) {
					setAllTerminalsTheme(getTheme(state.theme).terminal);
				}
				// Re-sync agent hook provisioning with the persisted setting
				// (also refreshes the relay scripts after an app update).
				if (state?.agentHooksEnabled) {
					agentHooks.provision(true).catch(() => {});
				}
				// The module flag in terminalManager defaults to true — only
				// push a change when the user has disabled GPU acceleration.
				if (state?.gpuAccelerationEnabled === false) {
					setWebglEnabled(false);
				}
			},
		},
	),
);

// Apply the persisted theme and fonts immediately on load. Zustand's persist
// middleware rehydrates asynchronously (microtask), which is too late for CSS
// variables — the UI would flash the default theme/font first.
applyTheme(getTheme(PERSISTED_DEFAULTS.theme));
document.documentElement.style.setProperty(
	"--font-ui",
	PERSISTED_DEFAULTS.uiFontFamily,
);
document.documentElement.style.setProperty(
	"--font-mono",
	PERSISTED_DEFAULTS.terminalFontFamily,
);
document.documentElement.style.setProperty(
	"--ui-font-size",
	`${PERSISTED_DEFAULTS.uiFontSize}px`,
);

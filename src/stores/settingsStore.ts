import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_AGENTS, mergeAgentsWithBuiltins } from "../lib/agents";
import { agentHooks, updates } from "../lib/ipc";
import type { PreviewColorMode } from "../lib/previewColorMode";
import { nextPreviewColorMode } from "../lib/previewColorMode";
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
	sidebarWidth: number;
	rightSidebarWidth: number;
	rightSidebarPrRatio: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;
	terminalScrollback: number;
	shellPath: string | null;
	agents: CodingAgent[];
	lastOpenedDevEnvId: string | null;
	editorWordWrap: boolean;
	markdownPreviewAutoOpen: boolean;
	markdownPreviewColorMode: PreviewColorMode;
	agentHooksEnabled: boolean;
	gpuAccelerationEnabled: boolean;
	/** Whether the app checks for updates on launch + periodically. */
	autoCheckUpdatesEnabled: boolean;
	/** Update version the user chose to skip; suppresses its prompt until a
	 *  newer release ships. Null when nothing is skipped. */
	skippedUpdateVersion: string | null;

	setShellPath: (path: string | null) => void;
	setTerminalFontFamily: (font: string) => void;
	setUiFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setUiFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	setSidebarWidth: (width: number) => void;
	setRightSidebarWidth: (width: number) => void;
	setRightSidebarPrRatio: (ratio: number) => void;
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
	setLastOpenedDevEnvId: (id: string) => void;
	toggleEditorWordWrap: () => void;
	toggleMarkdownPreviewAutoOpen: () => void;
	toggleMarkdownPreviewColorMode: () => void;
	setAgentHooksEnabled: (enabled: boolean) => void;
	setGpuAcceleration: (enabled: boolean) => void;
	setAutoCheckUpdatesEnabled: (enabled: boolean) => void;
	setSkippedUpdateVersion: (version: string | null) => void;
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
	rightSidebarWidth: number;
	rightSidebarPrRatio: number;
	debugActivityMeter: boolean;
	activityByteThreshold: number;
	terminalScrollback: number;
	shellPath: string | null;
	agents: CodingAgent[];
	lastOpenedDevEnvId: string | null;
	editorWordWrap: boolean;
	markdownPreviewAutoOpen: boolean;
	markdownPreviewColorMode: PreviewColorMode;
	agentHooksEnabled: boolean;
	gpuAccelerationEnabled: boolean;
	autoCheckUpdatesEnabled: boolean;
	skippedUpdateVersion: string | null;
} = (() => {
	const defaults = {
		terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		uiFontFamily: "system-ui, -apple-system, sans-serif",
		fontSize: 14,
		uiFontSize: 14,
		theme: "default",
		sidebarWidth: 280,
		rightSidebarWidth: 360,
		rightSidebarPrRatio: 0.5,
		debugActivityMeter: false,
		activityByteThreshold: 1024,
		terminalScrollback: 1000,
		shellPath: null as string | null,
		agents: BUILTIN_AGENTS as CodingAgent[],
		lastOpenedDevEnvId: null as string | null,
		editorWordWrap: true,
		markdownPreviewAutoOpen: true,
		markdownPreviewColorMode: "auto" as PreviewColorMode,
		agentHooksEnabled: true,
		gpuAccelerationEnabled: true,
		autoCheckUpdatesEnabled: true,
		skippedUpdateVersion: null as string | null,
	};
	try {
		const raw = localStorage.getItem("abundio-settings");
		if (!raw) return defaults;
		const parsed = JSON.parse(raw);
		const s = parsed?.state;
		if (!s) return defaults;
		// Accept either the new keys or the pre-ADR-0010 keys so the synchronous
		// read here matches what the persist middleware's migrate function will
		// produce a microtask later. Without this, the very first render uses
		// the default width/ratio even though the user has older values stored.
		const rawRightSidebarWidth =
			typeof s.rightSidebarWidth === "number"
				? s.rightSidebarWidth
				: typeof s.gitPanelWidth === "number"
					? s.gitPanelWidth
					: defaults.rightSidebarWidth;
		const rawRightSidebarPrRatio =
			typeof s.rightSidebarPrRatio === "number"
				? s.rightSidebarPrRatio
				: typeof s.gitPanelSplitRatio === "number"
					? s.gitPanelSplitRatio
					: defaults.rightSidebarPrRatio;
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
			rightSidebarWidth: rawRightSidebarWidth,
			rightSidebarPrRatio: rawRightSidebarPrRatio,
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
			markdownPreviewColorMode:
				s.markdownPreviewColorMode === "light" ||
				s.markdownPreviewColorMode === "auto"
					? s.markdownPreviewColorMode
					: defaults.markdownPreviewColorMode,
			agentHooksEnabled:
				typeof s.agentHooksEnabled === "boolean"
					? s.agentHooksEnabled
					: defaults.agentHooksEnabled,
			gpuAccelerationEnabled:
				typeof s.gpuAccelerationEnabled === "boolean"
					? s.gpuAccelerationEnabled
					: defaults.gpuAccelerationEnabled,
			autoCheckUpdatesEnabled:
				typeof s.autoCheckUpdatesEnabled === "boolean"
					? s.autoCheckUpdatesEnabled
					: defaults.autoCheckUpdatesEnabled,
			skippedUpdateVersion:
				typeof s.skippedUpdateVersion === "string"
					? s.skippedUpdateVersion
					: defaults.skippedUpdateVersion,
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
			sidebarWidth: PERSISTED_DEFAULTS.sidebarWidth,
			rightSidebarWidth: PERSISTED_DEFAULTS.rightSidebarWidth,
			rightSidebarPrRatio: PERSISTED_DEFAULTS.rightSidebarPrRatio,
			debugActivityMeter: PERSISTED_DEFAULTS.debugActivityMeter,
			activityByteThreshold: PERSISTED_DEFAULTS.activityByteThreshold,
			terminalScrollback: PERSISTED_DEFAULTS.terminalScrollback,
			shellPath: PERSISTED_DEFAULTS.shellPath,
			agents: PERSISTED_DEFAULTS.agents,
			lastOpenedDevEnvId: PERSISTED_DEFAULTS.lastOpenedDevEnvId,
			editorWordWrap: PERSISTED_DEFAULTS.editorWordWrap,
			markdownPreviewAutoOpen: PERSISTED_DEFAULTS.markdownPreviewAutoOpen,
			markdownPreviewColorMode: PERSISTED_DEFAULTS.markdownPreviewColorMode,
			agentHooksEnabled: PERSISTED_DEFAULTS.agentHooksEnabled,
			gpuAccelerationEnabled: PERSISTED_DEFAULTS.gpuAccelerationEnabled,
			autoCheckUpdatesEnabled: PERSISTED_DEFAULTS.autoCheckUpdatesEnabled,
			skippedUpdateVersion: PERSISTED_DEFAULTS.skippedUpdateVersion,

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
			setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
			setRightSidebarWidth: (rightSidebarWidth) => set({ rightSidebarWidth }),
			setRightSidebarPrRatio: (rightSidebarPrRatio) =>
				set({ rightSidebarPrRatio }),
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
			setLastOpenedDevEnvId: (id) => set({ lastOpenedDevEnvId: id }),
			toggleEditorWordWrap: () =>
				set((s) => ({ editorWordWrap: !s.editorWordWrap })),
			toggleMarkdownPreviewAutoOpen: () =>
				set((s) => ({
					markdownPreviewAutoOpen: !s.markdownPreviewAutoOpen,
				})),
			toggleMarkdownPreviewColorMode: () =>
				set((s) => ({
					markdownPreviewColorMode: nextPreviewColorMode(
						s.markdownPreviewColorMode,
					),
				})),
			setAgentHooksEnabled: (agentHooksEnabled) => {
				// Provision/unprovision agent hook configs to match the setting.
				// The Rust side accumulates per-agent errors into a single message
				// (e.g. unparseable ~/.claude/settings.json, missing curl, read-only
				// hook file). Surface them to the devtools so a user reporting "the
				// status dot doesn't work for Claude" has a breadcrumb to follow.
				agentHooks.provision(agentHooksEnabled).catch((err) => {
					console.error("[agentHooks] provision failed:", err);
				});
				set({ agentHooksEnabled });
			},
			setGpuAcceleration: (gpuAccelerationEnabled) => {
				setWebglEnabled(gpuAccelerationEnabled);
				set({ gpuAccelerationEnabled });
			},
			setAutoCheckUpdatesEnabled: (autoCheckUpdatesEnabled) => {
				// Rust holds the app-wide auto-check flag (the background loop
				// reads it). Push the change immediately so any Window's toggle
				// takes effect without a restart. See ADR-0014.
				updates.setAutoCheck(autoCheckUpdatesEnabled).catch((err) => {
					console.error("[updates] setAutoCheck failed:", err);
				});
				set({ autoCheckUpdatesEnabled });
			},
			setSkippedUpdateVersion: (skippedUpdateVersion) =>
				set({ skippedUpdateVersion }),
		}),
		{
			name: "abundio-settings",
			version: 5,
			// biome-ignore lint/suspicious/noExplicitAny: persisted shape is opaque pre-migration
			migrate: (persistedState: any, version: number) => {
				if (!persistedState) return persistedState;
				let state = persistedState;
				if (version < 1 && state.activityByteThreshold === 512) {
					state = { ...state, activityByteThreshold: 1024 };
				}
				// v2: agent status hooks became on-by-default. Existing users who
				// only ever saw the beta-era off default are flipped on.
				if (version < 2) {
					state = { ...state, agentHooksEnabled: true };
				}
				// v3: the shellActivityStatus toggle is gone — shell-mode status
				// is always tracked. Drop the stale key so the in-memory shape
				// matches the TypeScript type. See ADR-0009.
				if (version < 3) {
					const { shellActivityStatus: _drop, ...rest } = state;
					state = rest;
				}
				// v4: right sidebar restructure (ADR-0010). The git panel became
				// one of three tabs in the right sidebar, so its width/ratio keys
				// rename. The left sidebar lost its bottom panel entirely, so
				// sidebarSplitRatio and sidebarBottomPanel are dropped.
				if (version < 4) {
					const {
						gitPanelWidth,
						gitPanelSplitRatio,
						sidebarSplitRatio: _dropSplit,
						sidebarBottomPanel: _dropBottom,
						...rest
					} = state;
					state = {
						...rest,
						rightSidebarWidth:
							typeof gitPanelWidth === "number" ? gitPanelWidth : 360,
						rightSidebarPrRatio:
							typeof gitPanelSplitRatio === "number" ? gitPanelSplitRatio : 0.5,
					};
				}
				// v5: in-app updater (ADR-0014). New keys default via the store's
				// initial state on merge; seed them here so the persisted shape is
				// explicit for users upgrading from v4.
				if (version < 5) {
					state = {
						autoCheckUpdatesEnabled: true,
						skippedUpdateVersion: null,
						...state,
					};
				}
				return state;
			},
			partialize: (state) => ({
				terminalFontFamily: state.terminalFontFamily,
				uiFontFamily: state.uiFontFamily,
				fontSize: state.fontSize,
				uiFontSize: state.uiFontSize,
				theme: state.theme,
				sidebarWidth: state.sidebarWidth,
				rightSidebarWidth: state.rightSidebarWidth,
				rightSidebarPrRatio: state.rightSidebarPrRatio,
				debugActivityMeter: state.debugActivityMeter,
				activityByteThreshold: state.activityByteThreshold,
				terminalScrollback: state.terminalScrollback,
				shellPath: state.shellPath,
				agents: state.agents,
				lastOpenedDevEnvId: state.lastOpenedDevEnvId,
				editorWordWrap: state.editorWordWrap,
				markdownPreviewAutoOpen: state.markdownPreviewAutoOpen,
				markdownPreviewColorMode: state.markdownPreviewColorMode,
				agentHooksEnabled: state.agentHooksEnabled,
				gpuAccelerationEnabled: state.gpuAccelerationEnabled,
				autoCheckUpdatesEnabled: state.autoCheckUpdatesEnabled,
				skippedUpdateVersion: state.skippedUpdateVersion,
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
					// applyTheme writes CSS variables to :root — without this,
					// rehydrate (e.g. cross-window theme sync after the user
					// picks a new theme in the Settings window) would update
					// the in-memory `theme` value but leave UI colours frozen.
					applyTheme(getTheme(state.theme));
					setAllTerminalsTheme(getTheme(state.theme).terminal);
				}
				if (state?.uiFontFamily) {
					document.documentElement.style.setProperty(
						"--font-ui",
						state.uiFontFamily,
					);
				}
				if (state?.terminalFontFamily) {
					document.documentElement.style.setProperty(
						"--font-mono",
						state.terminalFontFamily,
					);
				}
				if (state?.uiFontSize) {
					document.documentElement.style.setProperty(
						"--ui-font-size",
						`${state.uiFontSize}px`,
					);
				}
				// Re-sync agent hook provisioning with the persisted setting
				// (also refreshes the relay scripts after an app update).
				if (state?.agentHooksEnabled) {
					agentHooks.provision(true).catch((err) => {
						console.error("[agentHooks] provision failed:", err);
					});
				}
				// The module flag in terminalManager defaults to true — only
				// push a change when the user has disabled GPU acceleration.
				if (state?.gpuAccelerationEnabled === false) {
					setWebglEnabled(false);
				}
				// Sync the Rust-side auto-check flag with the persisted setting on
				// startup (the Rust background loop's source of truth). Defaults
				// to enabled, so only push when explicitly disabled.
				if (state?.autoCheckUpdatesEnabled === false) {
					updates.setAutoCheck(false).catch(() => {});
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

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_AGENTS, mergeAgentsWithBuiltins } from "../lib/agents";
import { agentHooks, pr, updates } from "../lib/ipc";
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

/**
 * IDs of agents whose hooks should be provisioned — those with their per-agent
 * detection toggle on. Hook provisioning is gated by BOTH the global Status
 * Hooks setting and the agent's own toggle. Rust filters this to the agents it
 * actually supports, so custom/unsupported agents here are harmless.
 */
function provisionableAgentIds(agents: CodingAgent[]): string[] {
	return agents.filter((a) => a.enabled).map((a) => a.id);
}

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
	/** When an image is dropped onto a running agent, paste it via the clipboard
	 *  (so the agent recognises it) instead of inserting its file path. See the
	 *  "Smart image drop" term in CONTEXT.md. */
	smartImageDrop: boolean;
	/** Whether the app checks for updates on launch + periodically. */
	autoCheckUpdatesEnabled: boolean;
	/** Update version the user chose to skip; suppresses its prompt until a
	 *  newer release ships. Null when nothing is skipped. */
	skippedUpdateVersion: string | null;
	/** Whether the app-global GitHub PR poller runs automatically. See ADR-0019. */
	prPollEnabled: boolean;
	/** Focused-cadence PR poll interval in minutes (1–30). */
	prPollIntervalMinutes: number;

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
	/** Resolves once hook provisioning for the new state has settled, so callers
	 *  (e.g. Settings) can refresh the per-agent footprint afterwards. */
	toggleAgent: (id: string) => Promise<void>;
	updateAgent: (
		id: string,
		updates: Partial<Pick<CodingAgent, "name" | "command" | "args">>,
	) => void;
	setLastOpenedDevEnvId: (id: string) => void;
	toggleEditorWordWrap: () => void;
	toggleMarkdownPreviewAutoOpen: () => void;
	toggleMarkdownPreviewColorMode: () => void;
	/** Resolves once (un)provisioning has settled — see `toggleAgent`. */
	setAgentHooksEnabled: (enabled: boolean) => Promise<void>;
	setGpuAcceleration: (enabled: boolean) => void;
	setSmartImageDrop: (enabled: boolean) => void;
	setAutoCheckUpdatesEnabled: (enabled: boolean) => void;
	setSkippedUpdateVersion: (version: string | null) => void;
	setPrPollEnabled: (enabled: boolean) => void;
	setPrPollIntervalMinutes: (minutes: number) => void;
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
	smartImageDrop: boolean;
	autoCheckUpdatesEnabled: boolean;
	skippedUpdateVersion: string | null;
	prPollEnabled: boolean;
	prPollIntervalMinutes: number;
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
		smartImageDrop: true,
		autoCheckUpdatesEnabled: true,
		skippedUpdateVersion: null as string | null,
		prPollEnabled: true,
		prPollIntervalMinutes: 5,
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
			smartImageDrop:
				typeof s.smartImageDrop === "boolean"
					? s.smartImageDrop
					: defaults.smartImageDrop,
			autoCheckUpdatesEnabled:
				typeof s.autoCheckUpdatesEnabled === "boolean"
					? s.autoCheckUpdatesEnabled
					: defaults.autoCheckUpdatesEnabled,
			skippedUpdateVersion:
				typeof s.skippedUpdateVersion === "string"
					? s.skippedUpdateVersion
					: defaults.skippedUpdateVersion,
			prPollEnabled:
				typeof s.prPollEnabled === "boolean"
					? s.prPollEnabled
					: defaults.prPollEnabled,
			prPollIntervalMinutes:
				typeof s.prPollIntervalMinutes === "number"
					? s.prPollIntervalMinutes
					: defaults.prPollIntervalMinutes,
		};
	} catch {
		return defaults;
	}
})();

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set, get) => ({
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
			smartImageDrop: PERSISTED_DEFAULTS.smartImageDrop,
			autoCheckUpdatesEnabled: PERSISTED_DEFAULTS.autoCheckUpdatesEnabled,
			skippedUpdateVersion: PERSISTED_DEFAULTS.skippedUpdateVersion,
			prPollEnabled: PERSISTED_DEFAULTS.prPollEnabled,
			prPollIntervalMinutes: PERSISTED_DEFAULTS.prPollIntervalMinutes,

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
				// Sync hook provisioning to the new per-agent state — install the
				// toggled agent's hooks when turning it on, remove them when turning
				// it off. Only when the global Status Hooks setting is on; when it's
				// off there are no hooks to add or remove. provision() re-syncs every
				// supported agent to match its toggle, so the disabled one is stripped.
				// Returns the provision promise so callers can refresh the footprint.
				const state = get();
				if (!state.agentHooksEnabled) return Promise.resolve();
				return agentHooks
					.provision(true, provisionableAgentIds(state.agents))
					.catch((err) => {
						console.error("[agentHooks] provision failed:", err);
					});
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
				// Returns the provision promise so callers can refresh the footprint.
				set({ agentHooksEnabled });
				return agentHooks
					.provision(agentHooksEnabled, provisionableAgentIds(get().agents))
					.catch((err) => {
						console.error("[agentHooks] provision failed:", err);
					});
			},
			setGpuAcceleration: (gpuAccelerationEnabled) => {
				setWebglEnabled(gpuAccelerationEnabled);
				set({ gpuAccelerationEnabled });
			},
			setSmartImageDrop: (smartImageDrop) => set({ smartImageDrop }),
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
			setPrPollEnabled: (prPollEnabled) => {
				// Rust owns the running poller; push so the change (incl. "Off")
				// takes effect immediately in every Window. See ADR-0019.
				pr.setConfig(prPollEnabled, get().prPollIntervalMinutes).catch(
					() => {},
				);
				set({ prPollEnabled });
			},
			setPrPollIntervalMinutes: (minutes) => {
				const prPollIntervalMinutes = Math.min(
					30,
					Math.max(1, Math.round(minutes)),
				);
				pr.setConfig(get().prPollEnabled, prPollIntervalMinutes).catch(
					() => {},
				);
				set({ prPollIntervalMinutes });
			},
		}),
		{
			name: "abundio-settings",
			version: 7,
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
				// v5: in-app updater (ADR-0014). Belt-and-suspenders only — the
				// synchronous PERSISTED_DEFAULTS read and `merge` already supply
				// these keys when a v4 snapshot lacks them. The spread keeps any
				// persisted value (spread last) and just guarantees the keys exist
				// during the rehydrate microtask window. Safe to drop if the
				// PERSISTED_DEFAULTS path is ever proven sufficient on its own.
				if (version < 5) {
					state = {
						autoCheckUpdatesEnabled: true,
						skippedUpdateVersion: null,
						...state,
					};
				}
				// v6: Smart image drop (default on). Additive default-true key;
				// PERSISTED_DEFAULTS + merge already supply it, so this only
				// guarantees the key exists during the rehydrate window.
				if (version < 6) {
					state = { smartImageDrop: true, ...state };
				}
				// v7: app-global PR poller (ADR-0019). Additive default keys;
				// PERSISTED_DEFAULTS + merge already supply them — this only
				// guarantees they exist during the rehydrate window.
				if (version < 7) {
					state = {
						prPollEnabled: true,
						prPollIntervalMinutes: 5,
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
				smartImageDrop: state.smartImageDrop,
				autoCheckUpdatesEnabled: state.autoCheckUpdatesEnabled,
				skippedUpdateVersion: state.skippedUpdateVersion,
				prPollEnabled: state.prPollEnabled,
				prPollIntervalMinutes: state.prPollIntervalMinutes,
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
				// Re-sync agent hook provisioning with the persisted setting on
				// startup. Uses the once-per-process startup command so that, with
				// multiple Windows open, only the first rehydrate actually rewrites
				// the global agent configs. See ADR-0003 (Revisited).
				if (state?.agentHooksEnabled) {
					agentHooks
						.provisionStartup(true, provisionableAgentIds(state.agents))
						.catch((err) => {
							console.error("[agentHooks] startup provision failed:", err);
						});
				}
				// The module flag in terminalManager defaults to true — only
				// push a change when the user has disabled GPU acceleration.
				if (state?.gpuAccelerationEnabled === false) {
					setWebglEnabled(false);
				}
				// Sync the Rust-side auto-check flag with the persisted setting on
				// startup. Rust defaults this OFF and waits for this explicit push
				// (see updater.rs), so always send the value — not only when
				// disabled — otherwise auto-check would never turn on.
				updates
					.setAutoCheck(state?.autoCheckUpdatesEnabled ?? true)
					.catch(() => {});
				// Push the persisted PR-poller config to Rust on startup +
				// cross-window sync. The poller defaults to enabled/5min, but a
				// custom interval or "Off" must be applied. See ADR-0019.
				pr.setConfig(
					state?.prPollEnabled ?? true,
					state?.prPollIntervalMinutes ?? 5,
				).catch(() => {});
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

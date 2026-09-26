import { create } from "zustand";
import { persist } from "zustand/middleware";
import { seedWatchedFromInstalled } from "../lib/agentSeeding";
import { BUILTIN_AGENTS, mergeAgentsWithBuiltins } from "../lib/agents";
import { agentHooks, pr, updates } from "../lib/ipc";
import { SYSTEM_UI_FONT } from "../lib/nerdFonts";
import type { PreviewColorMode } from "../lib/previewColorMode";
import { nextPreviewColorMode } from "../lib/previewColorMode";
import {
	DEFAULT_ISSUE_TEMPLATE,
	DEFAULT_TASK_TEMPLATE,
} from "../lib/taskPrompt";
import { withTerminalSettings } from "../lib/terminalSettingsBridge";
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
	/** Height share of the **Commits** section, carved out of the tab
	 *  content's side of `rightSidebarPrRatio`. See `lib/rightSidebarLayout.ts`. */
	rightSidebarCommitsShare: number;
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
	/** Refuse to hand the mouse to programs running in a terminal pane, so
	 *  click-drag selection and right-click keep working everywhere. The default
	 *  for every pane; the pane's mouse badge overrides it one pane at a time.
	 *  See ADR-0031. */
	blockMouseReporting: boolean;
	/** When an image is dropped onto a running agent, paste it via the clipboard
	 *  (so the agent recognises it) instead of inserting its file path. See the
	 *  "Smart image drop" term in CONTEXT.md. */
	smartImageDrop: boolean;
	/** Whether the Action bar renders at the bottom of agent panes. Off hides
	 *  the strip everywhere without deleting anyone's Prompt actions — the
	 *  Command palette still reaches them. A preference, which is why it lives
	 *  here and the actions themselves do not (ADR-0039). */
	showActionBar: boolean;
	/** Whether a Pane plays the **Focus sweep** when it becomes the Focused
	 *  pane. A look-and-feel preference, set in Settings ▸ Theme. */
	focusSweep: boolean;
	/** Whether the app checks for updates on launch + periodically. */
	autoCheckUpdatesEnabled: boolean;
	/** Update version the user chose to skip; suppresses its prompt until a
	 *  newer release ships. Null when nothing is skipped. */
	skippedUpdateVersion: string | null;
	/** Epoch ms until which "Later" suppresses the update prompt (all versions).
	 *  Null when not snoozed; a past value is treated as expired. See ADR-0014. */
	updateSnoozedUntil: number | null;
	/** Whether the app-global GitHub PR poller runs automatically. See ADR-0019. */
	prPollEnabled: boolean;
	/** Focused-cadence PR poll interval in minutes (1–30). */
	prPollIntervalMinutes: number;
	/** The **Task template**: wraps a free-text Task (`{{input}}`). */
	taskTemplate: string;
	/** The **Issue template**: wraps an Issue task (`{{number}}` etc.). */
	issueTemplate: string;
	/** The remembered **Task destination** for the current Workspace. Changes
	 *  only on an explicit pick, never when Restart agent is unavailable. */
	taskDestination: TaskDestinationPreference;

	setShellPath: (path: string | null) => void;
	setTerminalFontFamily: (font: string) => void;
	setUiFontFamily: (font: string) => void;
	setFontSize: (size: number) => void;
	setUiFontSize: (size: number) => void;
	setTheme: (theme: string) => void;
	setSidebarWidth: (width: number) => void;
	setRightSidebarWidth: (width: number) => void;
	setRightSidebarPrRatio: (ratio: number) => void;
	setRightSidebarCommitsShare: (share: number) => void;
	toggleDebugActivityMeter: () => void;
	setActivityByteThreshold: (n: number) => void;
	setTerminalScrollback: (n: number) => void;
	addAgent: (
		name: string,
		command: string,
		args?: string[],
		taskArgs?: string[],
	) => void;
	removeAgent: (id: string) => void;
	/** Resolves once hook provisioning for the new state has settled, so callers
	 *  (e.g. Settings) can refresh the per-agent footprint afterwards. */
	toggleAgent: (id: string) => Promise<void>;
	/** Set every built-in Agent's Watched toggle from the commands found on
	 *  `$PATH`, leaving custom Agents alone, then re-sync hook provisioning.
	 *  The rule lives in `lib/agentSeeding.ts` and is shared by the first-run
	 *  seed and the Settings button, so the two cannot drift. See ADR-0037.
	 *
	 *  `"empty-scan"` means the scan found nothing and nothing was changed —
	 *  treated as a failed scan, never as a machine with no Agents. */
	matchAgentsToInstalled: (
		installed: Set<string>,
	) => Promise<"changed" | "already-matching" | "empty-scan">;
	updateAgent: (
		id: string,
		updates: Partial<
			Pick<CodingAgent, "name" | "command" | "args" | "taskArgs">
		>,
	) => void;
	setLastOpenedDevEnvId: (id: string) => void;
	toggleEditorWordWrap: () => void;
	toggleMarkdownPreviewAutoOpen: () => void;
	toggleMarkdownPreviewColorMode: () => void;
	/** Resolves once (un)provisioning has settled — see `toggleAgent`. */
	setAgentHooksEnabled: (enabled: boolean) => Promise<void>;
	setGpuAcceleration: (enabled: boolean) => void;
	setBlockMouseReporting: (enabled: boolean) => void;
	setSmartImageDrop: (enabled: boolean) => void;
	setFocusSweep: (enabled: boolean) => void;
	setShowActionBar: (enabled: boolean) => void;
	setAutoCheckUpdatesEnabled: (enabled: boolean) => void;
	setSkippedUpdateVersion: (version: string | null) => void;
	setUpdateSnoozedUntil: (until: number | null) => void;
	setPrPollEnabled: (enabled: boolean) => void;
	setPrPollIntervalMinutes: (minutes: number) => void;
	setTaskTemplate: (template: string) => void;
	setIssueTemplate: (template: string) => void;
	setTaskDestination: (destination: TaskDestinationPreference) => void;
}

/** The **Task destination** New task opens on; the last one explicitly
 *  picked. Defaults to New worktree. */
export type TaskDestinationPreference = "restart" | "newTab" | "worktree";

/**
 * Every key `persist` writes to localStorage — the single source of truth for
 * `partialize`.
 *
 * Exported because the cross-window broadcast derives its payload from this
 * list minus a small denylist (`NOT_BROADCAST` in `lib/settingsBroadcast.ts`).
 * One list means a newly-added global setting propagates to other Windows *by
 * default* instead of silently not propagating — the failure mode that lost
 * `shellPath`, `autoCheckUpdatesEnabled`, `editorWordWrap`, `debugActivityMeter`
 * and `markdownPreviewAutoOpen`. See ADR-0008.
 */
export const PERSISTED_KEYS = [
	"terminalFontFamily",
	"uiFontFamily",
	"fontSize",
	"uiFontSize",
	"theme",
	"sidebarWidth",
	"rightSidebarWidth",
	"rightSidebarPrRatio",
	"rightSidebarCommitsShare",
	"debugActivityMeter",
	"activityByteThreshold",
	"terminalScrollback",
	"shellPath",
	"agents",
	"lastOpenedDevEnvId",
	"editorWordWrap",
	"markdownPreviewAutoOpen",
	"markdownPreviewColorMode",
	"agentHooksEnabled",
	"gpuAccelerationEnabled",
	"blockMouseReporting",
	"smartImageDrop",
	"showActionBar",
	"focusSweep",
	"autoCheckUpdatesEnabled",
	"skippedUpdateVersion",
	"updateSnoozedUntil",
	"prPollEnabled",
	"prPollIntervalMinutes",
	"taskTemplate",
	"issueTemplate",
	"taskDestination",
] as const satisfies readonly (keyof SettingsState)[];

export type PersistedSettingKey = (typeof PERSISTED_KEYS)[number];
export type PersistedSettings = Pick<SettingsState, PersistedSettingKey>;

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
	/** Height share of the **Commits** section, carved out of the tab
	 *  content's side of `rightSidebarPrRatio`. See `lib/rightSidebarLayout.ts`. */
	rightSidebarCommitsShare: number;
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
	blockMouseReporting: boolean;
	smartImageDrop: boolean;
	showActionBar: boolean;
	focusSweep: boolean;
	autoCheckUpdatesEnabled: boolean;
	skippedUpdateVersion: string | null;
	updateSnoozedUntil: number | null;
	prPollEnabled: boolean;
	prPollIntervalMinutes: number;
	taskTemplate: string;
	issueTemplate: string;
	taskDestination: TaskDestinationPreference;
} = (() => {
	const defaults = {
		terminalFontFamily: "'JetBrainsMonoNL Nerd Font Mono', monospace",
		uiFontFamily: SYSTEM_UI_FONT.name,
		fontSize: 14,
		uiFontSize: 14,
		theme: "default",
		sidebarWidth: 280,
		rightSidebarWidth: 360,
		rightSidebarPrRatio: 0.5,
		rightSidebarCommitsShare: 0.2,
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
		blockMouseReporting: true,
		smartImageDrop: true,
		showActionBar: true,
		focusSweep: true,
		autoCheckUpdatesEnabled: true,
		skippedUpdateVersion: null as string | null,
		updateSnoozedUntil: null as number | null,
		prPollEnabled: true,
		prPollIntervalMinutes: 5,
		taskTemplate: DEFAULT_TASK_TEMPLATE,
		issueTemplate: DEFAULT_ISSUE_TEMPLATE,
		taskDestination: "worktree" as TaskDestinationPreference,
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
			rightSidebarCommitsShare:
				typeof s.rightSidebarCommitsShare === "number"
					? s.rightSidebarCommitsShare
					: defaults.rightSidebarCommitsShare,
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
			blockMouseReporting:
				typeof s.blockMouseReporting === "boolean"
					? s.blockMouseReporting
					: defaults.blockMouseReporting,
			smartImageDrop:
				typeof s.smartImageDrop === "boolean"
					? s.smartImageDrop
					: defaults.smartImageDrop,
			showActionBar:
				typeof s.showActionBar === "boolean"
					? s.showActionBar
					: defaults.showActionBar,
			focusSweep:
				typeof s.focusSweep === "boolean" ? s.focusSweep : defaults.focusSweep,
			autoCheckUpdatesEnabled:
				typeof s.autoCheckUpdatesEnabled === "boolean"
					? s.autoCheckUpdatesEnabled
					: defaults.autoCheckUpdatesEnabled,
			skippedUpdateVersion:
				typeof s.skippedUpdateVersion === "string"
					? s.skippedUpdateVersion
					: defaults.skippedUpdateVersion,
			updateSnoozedUntil:
				typeof s.updateSnoozedUntil === "number"
					? s.updateSnoozedUntil
					: defaults.updateSnoozedUntil,
			prPollEnabled:
				typeof s.prPollEnabled === "boolean"
					? s.prPollEnabled
					: defaults.prPollEnabled,
			prPollIntervalMinutes:
				typeof s.prPollIntervalMinutes === "number"
					? s.prPollIntervalMinutes
					: defaults.prPollIntervalMinutes,
			taskTemplate:
				typeof s.taskTemplate === "string"
					? s.taskTemplate
					: defaults.taskTemplate,
			issueTemplate:
				typeof s.issueTemplate === "string"
					? s.issueTemplate
					: defaults.issueTemplate,
			taskDestination:
				s.taskDestination === "restart" ||
				s.taskDestination === "newTab" ||
				s.taskDestination === "worktree"
					? s.taskDestination
					: defaults.taskDestination,
		};
	} catch {
		return defaults;
	}
})();

/**
 * Push rehydrated settings out to everything that lives outside the store:
 * xterm instances, the mouse-reporting master switch, and the Rust side.
 *
 * Called on first hydration AND on every cross-Window sync (ADR-0008), so each
 * push must be safe to repeat and must send the value in BOTH directions — a
 * one-directional push would leave the other Window stuck on the old answer.
 */
function applyRehydratedSettings(state: SettingsState | undefined): void {
	if (state?.activityByteThreshold != null) {
		withTerminalSettings((t) =>
			t.setActivityByteThreshold(state.activityByteThreshold),
		);
	}
	if (state?.terminalScrollback != null) {
		withTerminalSettings((t) =>
			t.setAllTerminalsScrollback(state.terminalScrollback),
		);
	}
	// Fix race: terminals created before rehydration have default font/theme.
	if (state?.terminalFontFamily) {
		withTerminalSettings((t) =>
			t.setAllTerminalsFontFamily(state.terminalFontFamily),
		);
	}
	if (state?.fontSize) {
		withTerminalSettings((t) => t.setAllTerminalsFontSize(state.fontSize));
	}
	if (state?.theme) {
		// applyTheme writes CSS variables to :root — without this,
		// rehydrate (e.g. cross-window theme sync after the user
		// picks a new theme in the Settings window) would update
		// the in-memory `theme` value but leave UI colours frozen.
		applyTheme(getTheme(state.theme));
		withTerminalSettings((t) =>
			t.setAllTerminalsTheme(getTheme(state.theme).terminal),
		);
	}
	if (state?.uiFontFamily) {
		document.documentElement.style.setProperty("--font-ui", state.uiFontFamily);
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
	// Always pushed, not only when false. This same handler runs on
	// cross-Window sync (ADR-0008), where GPU may need turning back ON —
	// a one-directional push would leave the other Window on the DOM
	// renderer after the user re-enabled acceleration here.
	// setWebglEnabled no-ops when the value is unchanged.
	withTerminalSettings((t) =>
		t.setWebglEnabled(state?.gpuAccelerationEnabled ?? true),
	);
	// Always pushed, not only when false. This same handler runs on
	// cross-Window sync (ADR-0008), where the flag may need turning back
	// ON — a one-directional push would leave the other Window blocking
	// after the user un-blocked here. setMouseReportingBlocked no-ops
	// when the value is unchanged, so the extra call costs nothing.
	withTerminalSettings((t) =>
		t.setMouseReportingBlocked(state?.blockMouseReporting ?? true),
	);
	// Sync the Rust-side auto-check flag with the persisted setting on
	// startup. Rust defaults this OFF and waits for this explicit push
	// (see updater.rs), so always send the value — not only when
	// disabled — otherwise auto-check would never turn on.
	updates.setAutoCheck(state?.autoCheckUpdatesEnabled ?? true).catch(() => {});
	// Push the persisted PR-poller config to Rust on startup +
	// cross-window sync. The poller defaults to enabled/5min, but a
	// custom interval or "Off" must be applied. See ADR-0019.
	pr.setConfig(
		state?.prPollEnabled ?? true,
		state?.prPollIntervalMinutes ?? 5,
	).catch(() => {});
}

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
			rightSidebarCommitsShare: PERSISTED_DEFAULTS.rightSidebarCommitsShare,
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
			blockMouseReporting: PERSISTED_DEFAULTS.blockMouseReporting,
			smartImageDrop: PERSISTED_DEFAULTS.smartImageDrop,
			showActionBar: PERSISTED_DEFAULTS.showActionBar,
			focusSweep: PERSISTED_DEFAULTS.focusSweep,
			autoCheckUpdatesEnabled: PERSISTED_DEFAULTS.autoCheckUpdatesEnabled,
			skippedUpdateVersion: PERSISTED_DEFAULTS.skippedUpdateVersion,
			updateSnoozedUntil: PERSISTED_DEFAULTS.updateSnoozedUntil,
			prPollEnabled: PERSISTED_DEFAULTS.prPollEnabled,
			prPollIntervalMinutes: PERSISTED_DEFAULTS.prPollIntervalMinutes,
			taskTemplate: PERSISTED_DEFAULTS.taskTemplate,
			issueTemplate: PERSISTED_DEFAULTS.issueTemplate,
			taskDestination: PERSISTED_DEFAULTS.taskDestination,

			setShellPath: (shellPath) => set({ shellPath }),
			setTerminalFontFamily: (terminalFontFamily) => {
				document.documentElement.style.setProperty(
					"--font-mono",
					terminalFontFamily,
				);
				withTerminalSettings((t) =>
					t.setAllTerminalsFontFamily(terminalFontFamily),
				);
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
				withTerminalSettings((t) => t.setAllTerminalsTheme(fullTheme.terminal));
				set({ theme: themeName });
			},
			setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
			setRightSidebarWidth: (rightSidebarWidth) => set({ rightSidebarWidth }),
			setRightSidebarPrRatio: (rightSidebarPrRatio) =>
				set({ rightSidebarPrRatio }),
			setRightSidebarCommitsShare: (rightSidebarCommitsShare) =>
				set({ rightSidebarCommitsShare }),
			toggleDebugActivityMeter: () =>
				set((state) => ({ debugActivityMeter: !state.debugActivityMeter })),
			setActivityByteThreshold: (n) => {
				withTerminalSettings((t) => t.setActivityByteThreshold(n));
				set({ activityByteThreshold: n });
			},
			setTerminalScrollback: (n) => {
				withTerminalSettings((t) => t.setAllTerminalsScrollback(n));
				set({ terminalScrollback: n });
			},
			addAgent: (name, command, args, taskArgs) => {
				const id = `custom-${crypto.randomUUID()}`;
				set((s) => ({
					agents: [
						...s.agents,
						{
							id,
							name,
							command,
							args,
							taskArgs,
							builtin: false,
							enabled: true,
						},
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
			matchAgentsToInstalled: async (installed) => {
				if (installed.size === 0) return "empty-scan";
				const before = get().agents;
				const after = seedWatchedFromInstalled(before, installed);
				// Identity, not deep equality: seedWatchedFromInstalled returns the
				// input when nothing moved, so this skips a redundant store write,
				// a re-provision and the cross-Window broadcast that rides on it.
				if (after === before) return "already-matching";
				set({ agents: after });
				// Same re-sync toggleAgent does. It matters at first run too:
				// `provisionStartup` has already run for all nine built-ins by the
				// time the scan lands, so an Agent seeded off that happens to have
				// a stale config dir must lose its entries here.
				if (get().agentHooksEnabled) {
					await agentHooks
						.provision(true, provisionableAgentIds(after))
						.catch((err) => {
							console.error("[agentHooks] provision failed:", err);
						});
				}
				return "changed";
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
				withTerminalSettings((t) => t.setWebglEnabled(gpuAccelerationEnabled));
				set({ gpuAccelerationEnabled });
			},
			setBlockMouseReporting: (blockMouseReporting) => {
				withTerminalSettings((t) =>
					t.setMouseReportingBlocked(blockMouseReporting),
				);
				set({ blockMouseReporting });
			},
			setSmartImageDrop: (smartImageDrop) => set({ smartImageDrop }),
			setShowActionBar: (showActionBar) => set({ showActionBar }),
			setFocusSweep: (focusSweep) => set({ focusSweep }),
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
			setUpdateSnoozedUntil: (updateSnoozedUntil) =>
				set({ updateSnoozedUntil }),
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
			setTaskTemplate: (taskTemplate) => set({ taskTemplate }),
			setIssueTemplate: (issueTemplate) => set({ issueTemplate }),
			setTaskDestination: (taskDestination) => set({ taskDestination }),
		}),
		{
			name: "abundio-settings",
			version: 13,
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
				// v10: the Action bar (default on). Additive default-true key;
				// PERSISTED_DEFAULTS + merge already supply it, so this only
				// guarantees the key exists during the rehydrate window.
				if (version < 10) {
					state = { showActionBar: true, ...state };
				}
				// v11: the Focus sweep (default on). Additive default-true key;
				// PERSISTED_DEFAULTS + merge already supply it, so this only
				// guarantees the key exists during the rehydrate window.
				if (version < 11) {
					state = { focusSweep: true, ...state };
				}
				// v12: New task templates and the remembered Task destination.
				// Additive keys; PERSISTED_DEFAULTS + merge already supply them,
				// so this only guarantees they exist during the rehydrate window.
				if (version < 12) {
					state = {
						taskTemplate: DEFAULT_TASK_TEMPLATE,
						issueTemplate: DEFAULT_ISSUE_TEMPLATE,
						taskDestination: "worktree",
						...state,
					};
				}
				// v13: New worktree became the default Task destination and is
				// now remembered too. Before v13 "newTab" was both the silent
				// default and a savable pick, and the two are indistinguishable,
				// so an explicit New tab choice is moved over too. "restart" was
				// always an explicit pick and is kept.
				if (version < 13 && state.taskDestination === "newTab") {
					state = { ...state, taskDestination: "worktree" };
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
				// v8: "Later" snooze for the update prompt (ADR-0014). Additive
				// default-null key; PERSISTED_DEFAULTS + merge already supply it —
				// this only guarantees it exists during the rehydrate window.
				if (version < 8) {
					state = { updateSnoozedUntil: null, ...state };
				}
				// v9: refuse mouse reporting by default (ADR-0031). Additive
				// default-true key; PERSISTED_DEFAULTS + merge already supply it —
				// this only guarantees it exists during the rehydrate window.
				if (version < 9) {
					state = { blockMouseReporting: true, ...state };
				}
				return state;
			},
			partialize: (state) =>
				Object.fromEntries(
					PERSISTED_KEYS.map((key) => [key, state[key]]),
				) as PersistedSettings,
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
			onRehydrateStorage: () => (state, error) => {
				if (error) {
					// zustand swallows a throw from this callback into its own promise
					// chain, so without this line a failed rehydrate is completely
					// invisible — which is exactly how this handler silently stopped
					// applying anything at all. See terminalSettingsBridge.ts.
					console.error("[settings] rehydrate failed", error);
					return;
				}
				try {
					applyRehydratedSettings(state);
				} catch (err) {
					// Contain the throw here rather than letting it reach persist's
					// .catch — that re-enters this callback with the error (so the side
					// effects above it have already run) and leaves `hasHydrated` false
					// with onFinishHydration listeners unfired.
					console.error("[settings] applying rehydrated settings failed", err);
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

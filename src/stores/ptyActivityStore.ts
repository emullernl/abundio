import { sendNotification } from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { findPaneLocation, isPaneVisible } from "../lib/notificationRouter";
import type {
	PaneNode,
	PtyActivityState,
	PtyDetectionMode,
	Tab,
} from "../lib/types";
import {
	getWindowBlurredMs,
	isAppWindowFocused,
	NOTIFICATION_BLUR_THRESHOLD_MS,
} from "../lib/windowFocus";
import { useWorkspaceStore } from "./workspaceStore";

// ── Constants ──

export const IDLE_THRESHOLD_MS = 2000;
const SCAN_INTERVAL_MS = 2000;
// Hook-driven PTYs trust hook events for transitions; the idle scanner is
// only a backstop for a genuinely stuck "active" dot (a dropped Stop event),
// so it uses a far longer threshold than the heuristic's 2s.
const HOOK_IDLE_BACKSTOP_MS = 30000;

// Hot-path optimization: track last output timestamps outside Zustand state
// to avoid triggering re-renders on every output chunk.
const lastOutputTimestamps = new Map<string, number>();

// Track whether a shell command is currently running (between command_start and command_end).
// Stored outside Zustand like lastOutputTimestamps to avoid re-renders.
const shellCommandRunning = new Map<string, boolean>();

/** Get the last output timestamp for a PTY (for use outside the store, e.g. DebugActivityMeter). */
export function getLastOutputAt(ptyId: string): number | null {
	return lastOutputTimestamps.get(ptyId) ?? null;
}

/** Refresh the last-output timestamp without triggering a Zustand state transition.
 *  Used in agent mode to keep the idle scanner from transitioning "active" → "ready"
 *  while output is still flowing but below the byte-accumulation threshold. */
export function touchLastOutput(ptyId: string, now?: number): void {
	lastOutputTimestamps.set(ptyId, now ?? Date.now());
}

export function isShellCommandRunning(ptyId: string): boolean {
	return shellCommandRunning.get(ptyId) ?? false;
}

export function setShellCommandRunning(ptyId: string, running: boolean): void {
	shellCommandRunning.set(ptyId, running);
}

// ── Types ──

export interface PtyActivityEntry {
	state: PtyActivityState;
	lastOutputAt: number | null;
	hasEverReceivedOutput: boolean;
	detectionMode: PtyDetectionMode;
	// True once an Agent hook event has driven this PTY's state. Hook events
	// are authoritative, so the byte-accumulation heuristic backs off.
	hookDriven: boolean;
}

interface PtyActivityState_Store {
	activities: Record<string, PtyActivityEntry>;
	titles: Record<string, string>;
	panePtyMap: Record<string, string>; // paneId → ptyId
	runningCommands: Record<string, string>; // ptyId → command text (empty when idle)
	cwds: Record<string, string>; // ptyId → live cwd path
	openedWorkspaceIds: Set<string>;
	agentPtyIds: Set<string>;
	detectedAgentIds: Record<string, string>; // ptyId → agentId detected via command_start

	initPty: (ptyId: string, mode?: PtyDetectionMode) => void;
	recordOutput: (ptyId: string) => void;
	recordError: (ptyId: string) => void;
	recordExitSuccess: (ptyId: string) => void;
	markIdle: (ptyId: string) => void;
	clearError: (ptyId: string) => void;
	applyHookEvent: (
		ptyId: string,
		transition: "active" | "waiting" | "ready" | "error",
	) => void;
	clearWaiting: (ptyId: string) => void;
	clearActive: (ptyId: string) => void;
	setAgentPty: (ptyId: string, agentId?: string) => void;
	clearAgentPty: (ptyId: string) => void;
	setTitle: (paneId: string, title: string) => void;
	setRunningCommand: (ptyId: string, text: string | null) => void;
	setCwd: (ptyId: string, path: string) => void;
	registerPane: (paneId: string, ptyId: string) => void;
	markWorkspaceOpened: (workspaceId: string) => void;
	unmarkWorkspaceOpened: (workspaceId: string) => void;
	removePty: (ptyId: string) => void;
	removePane: (paneId: string) => void;
}

// ── Store ──

export const usePtyActivityStore = create<PtyActivityState_Store>(
	(set, get) => ({
		activities: {},
		titles: {},
		panePtyMap: {},
		runningCommands: {},
		cwds: {},
		openedWorkspaceIds: new Set(),
		agentPtyIds: new Set(),
		detectedAgentIds: {},

		initPty: (ptyId, mode) => {
			const existing = get().activities[ptyId];
			if (existing) {
				// Update mode if explicitly provided
				if (mode && existing.detectionMode !== mode) {
					set((s) => ({
						activities: {
							...s.activities,
							[ptyId]: { ...s.activities[ptyId], detectionMode: mode },
						},
					}));
				}
				return;
			}
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: {
						state: "idle",
						lastOutputAt: null,
						hasEverReceivedOutput: true,
						detectionMode: mode ?? "shell",
						hookDriven: false,
					},
				},
			}));
		},

		recordOutput: (ptyId) => {
			const entry = get().activities[ptyId];
			// Skip set() if already active — this fires on every output chunk
			if (entry?.state === "active") {
				lastOutputTimestamps.set(ptyId, Date.now());
				return;
			}
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: {
						state: "active",
						lastOutputAt: Date.now(),
						hasEverReceivedOutput: true,
						detectionMode: s.activities[ptyId]?.detectionMode ?? "shell",
						hookDriven: s.activities[ptyId]?.hookDriven ?? false,
					},
				},
			}));
		},

		markIdle: (ptyId) => {
			const entry = get().activities[ptyId];
			if (
				!entry ||
				entry.state === "idle" ||
				entry.state === "error" ||
				// An agent waiting on the user is cleared only by a keystroke or
				// the next hook event — never by focus/click. Agent mode only;
				// a stale "waiting" on a terminal-mode pane falls through to be
				// cleared normally.
				(entry.state === "waiting" && entry.detectionMode === "agent")
			)
				return;
			// Agent mode: never cancel an in-progress "active" state. markIdle
			// is meant to dismiss "ready"/"error" alerts the user has
			// acknowledged (focus, click, etc.); for an agent that's still
			// streaming output, the work hasn't finished yet, so flipping the
			// dot from amber to green would lie about what's happening.
			if (entry.state === "active" && entry.detectionMode === "agent") return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "idle" },
				},
			}));
		},

		clearError: (ptyId) => {
			const entry = get().activities[ptyId];
			if (!entry || entry.state !== "error") return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "idle" },
				},
			}));
		},

		recordError: (ptyId) => {
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: {
						state: "error",
						lastOutputAt: s.activities[ptyId]?.lastOutputAt ?? null,
						hasEverReceivedOutput:
							s.activities[ptyId]?.hasEverReceivedOutput ?? false,
						detectionMode: s.activities[ptyId]?.detectionMode ?? "shell",
						hookDriven: s.activities[ptyId]?.hookDriven ?? false,
					},
				},
			}));
		},

		applyHookEvent: (ptyId, transition) => {
			const entry = get().activities[ptyId];
			if (!entry) return;
			if (transition === "active") {
				lastOutputTimestamps.set(ptyId, Date.now());
			}
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: {
						...s.activities[ptyId],
						state: transition,
						hookDriven: true,
						lastOutputAt:
							transition === "active"
								? Date.now()
								: s.activities[ptyId].lastOutputAt,
					},
				},
			}));
		},

		clearWaiting: (ptyId) => {
			// A keystroke answering an agent's permission prompt clears the
			// "waiting" dot. It goes to "idle", not "active": at this moment
			// the user is typing, not the agent working — showing amber would
			// lie. The next hook (Stop → ready, or another PermissionRequest)
			// drives the dot from here; agent output flips it back via the
			// idle scanner / recordOutput if work resumes before then.
			const entry = get().activities[ptyId];
			if (!entry || entry.state !== "waiting") return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "idle" },
				},
			}));
		},

		clearActive: (ptyId) => {
			// Counterpart to clearWaiting for the "user pressed ESC to cancel
			// an in-flight agent task" case. markIdle deliberately refuses to
			// move an agent's "active" → "idle" (focus/clicks must not lie
			// about agent progress); this is the explicit cancel path.
			const entry = get().activities[ptyId];
			if (!entry || entry.state !== "active" || entry.detectionMode !== "agent")
				return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "idle" },
				},
			}));
		},

		recordExitSuccess: (ptyId) => {
			const entry = get().activities[ptyId];
			if (!entry) return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "ready" },
				},
			}));
		},

		setAgentPty: (ptyId, agentId) => {
			const s = get();
			if (s.agentPtyIds.has(ptyId)) return;
			const newSet = new Set(s.agentPtyIds);
			newSet.add(ptyId);
			// Clear shell command tracking — agent mode doesn't use shell integration
			// sequences, so command_end will never fire to clear this flag.
			shellCommandRunning.delete(ptyId);
			const entry = s.activities[ptyId];
			const detectedUpdate = agentId
				? { detectedAgentIds: { ...s.detectedAgentIds, [ptyId]: agentId } }
				: {};
			if (entry) {
				set({
					agentPtyIds: newSet,
					activities: {
						...s.activities,
						[ptyId]: { ...entry, detectionMode: "agent" },
					},
					...detectedUpdate,
				});
			} else {
				set({ agentPtyIds: newSet, ...detectedUpdate });
			}
		},

		clearAgentPty: (ptyId) => {
			const s = get();
			if (!s.agentPtyIds.has(ptyId)) return;
			const newSet = new Set(s.agentPtyIds);
			newSet.delete(ptyId);
			const { [ptyId]: _, ...restDetected } = s.detectedAgentIds;
			const entry = s.activities[ptyId];
			if (entry) {
				set({
					agentPtyIds: newSet,
					detectedAgentIds: restDetected,
					activities: {
						...s.activities,
						[ptyId]: { ...entry, detectionMode: "shell", hookDriven: false },
					},
				});
			} else {
				set({ agentPtyIds: newSet, detectedAgentIds: restDetected });
			}
		},

		registerPane: (paneId, ptyId) => {
			if (get().panePtyMap[paneId] === ptyId) return;
			set((s) => ({ panePtyMap: { ...s.panePtyMap, [paneId]: ptyId } }));
		},

		setTitle: (paneId, title) => {
			if (get().titles[paneId] === title) return;
			set((s) => ({ titles: { ...s.titles, [paneId]: title } }));
		},

		setRunningCommand: (ptyId, text) => {
			const next = text ?? "";
			if (get().runningCommands[ptyId] === next) return;
			set((s) => ({
				runningCommands: { ...s.runningCommands, [ptyId]: next },
			}));
		},

		setCwd: (ptyId, path) => {
			if (get().cwds[ptyId] === path) return;
			set((s) => ({ cwds: { ...s.cwds, [ptyId]: path } }));
		},

		markWorkspaceOpened: (workspaceId) => {
			const s = get();
			if (s.openedWorkspaceIds.has(workspaceId)) return;
			set({
				openedWorkspaceIds: new Set([...s.openedWorkspaceIds, workspaceId]),
			});
		},

		unmarkWorkspaceOpened: (workspaceId) => {
			const s = get();
			if (!s.openedWorkspaceIds.has(workspaceId)) return;
			const next = new Set(s.openedWorkspaceIds);
			next.delete(workspaceId);
			set({ openedWorkspaceIds: next });
		},

		removePty: (ptyId) => {
			lastOutputTimestamps.delete(ptyId);
			shellCommandRunning.delete(ptyId);
			set((s) => {
				const { [ptyId]: _, ...rest } = s.activities;
				const { [ptyId]: _rc, ...restRunning } = s.runningCommands;
				const { [ptyId]: _cwd, ...restCwds } = s.cwds;
				const newAgentIds = new Set(s.agentPtyIds);
				const changed = newAgentIds.delete(ptyId);
				return changed
					? {
							activities: rest,
							agentPtyIds: newAgentIds,
							runningCommands: restRunning,
							cwds: restCwds,
						}
					: { activities: rest, runningCommands: restRunning, cwds: restCwds };
			});
		},

		removePane: (paneId) => {
			set((s) => {
				const { [paneId]: _t, ...restTitles } = s.titles;
				const { [paneId]: _p, ...restMap } = s.panePtyMap;
				return { titles: restTitles, panePtyMap: restMap };
			});
		},
	}),
);

// ── Idle scanner ──

// Injected by terminalManager after module init to avoid circular imports
let _getFocusedPaneId: (() => string | null) | null = null;

export function setFocusedPaneIdGetter(getter: () => string | null): void {
	_getFocusedPaneId = getter;
}

// Cached reverse map: only rebuilt when panePtyMap reference changes.
// Shared by the idle scanner (hot, every 2s) and the notifications subscriber
// (hottest path — fires on every recordOutput / setCwd / setTitle /
// setRunningCommand). The previous Object.entries(...).find(...) reverse
// lookup in the subscriber was O(panes) per state change.
let _cachedPanePtyMapRef: Record<string, string> | null = null;
let _cachedPtyToPaneMap: Record<string, string> = {};

function getPtyToPaneMap(
	panePtyMap: Record<string, string>,
): Record<string, string> {
	// Zustand produces a new object reference on mutation, so === is sufficient.
	if (panePtyMap !== _cachedPanePtyMapRef) {
		_cachedPanePtyMapRef = panePtyMap;
		_cachedPtyToPaneMap = {};
		for (const [paneId, ptyId] of Object.entries(panePtyMap)) {
			_cachedPtyToPaneMap[ptyId] = paneId;
		}
	}
	return _cachedPtyToPaneMap;
}

setInterval(() => {
	const { activities, panePtyMap } = usePtyActivityStore.getState();
	const now = Date.now();
	const updates: Record<string, PtyActivityEntry> = {};
	let hasChanges = false;

	const ptyToPane = getPtyToPaneMap(panePtyMap);

	const focusedPaneId = _getFocusedPaneId?.() ?? null;
	// If the getter hasn't been injected yet, treat every pane as focused
	// so we don't spam "ready" transitions during startup.
	const focusGetterReady = _getFocusedPaneId !== null;
	const appHasFocus = isAppWindowFocused();

	for (const [ptyId, entry] of Object.entries(activities)) {
		const lastOutput = lastOutputTimestamps.get(ptyId) ?? entry.lastOutputAt;
		if (lastOutput === null) continue;
		const elapsed = now - lastOutput;

		const threshold = entry.hookDriven
			? HOOK_IDLE_BACKSTOP_MS
			: IDLE_THRESHOLD_MS;
		if (entry.state === "active" && elapsed > threshold) {
			// Don't transition to idle if a shell command is still running
			if (shellCommandRunning.get(ptyId)) continue;
			const paneId = ptyToPane[ptyId];
			const isFocused =
				!focusGetterReady ||
				(appHasFocus && paneId != null && focusedPaneId === paneId);
			// Agent mode always goes to "ready" — the agent finished work and
			// is ready for user input, even when the terminal has focus.
			const nextState =
				isFocused && entry.detectionMode !== "agent" ? "idle" : "ready";
			updates[ptyId] = {
				...entry,
				state: nextState,
			};
			hasChanges = true;
		}
	}

	if (hasChanges) {
		usePtyActivityStore.setState((s) => ({
			activities: { ...s.activities, ...updates },
		}));
	}
}, SCAN_INTERVAL_MS);

// ── Notifications for state transitions ──

usePtyActivityStore.subscribe((state, prevState) => {
	const { activities, titles, panePtyMap } = state;
	const prevActivities = prevState.activities;
	const blurredMs = getWindowBlurredMs();
	const windowAwayLongEnough =
		blurredMs !== null && blurredMs >= NOTIFICATION_BLUR_THRESHOLD_MS;
	const ptyToPane = getPtyToPaneMap(panePtyMap);

	for (const [ptyId, entry] of Object.entries(activities)) {
		const prevEntry = prevActivities[ptyId];
		if (!prevEntry || prevEntry.state === entry.state) continue;
		if (
			entry.state !== "ready" &&
			entry.state !== "error" &&
			entry.state !== "waiting"
		)
			continue;

		const paneId = ptyToPane[ptyId];

		// "waiting" (agent blocked on the user) notifies whenever the pane is
		// not on screen — window blurred OR the pane is in a background
		// tab/workspace. "ready"/"error" keep the blurred-only gate.
		const shouldNotify =
			entry.state === "waiting"
				? windowAwayLongEnough || !paneId || !isPaneVisible(paneId)
				: windowAwayLongEnough;
		if (!shouldNotify) continue;

		const title = paneId ? titles[paneId] : undefined;
		const label =
			title || (entry.detectionMode === "agent" ? "Agent" : "Terminal");
		const body =
			entry.state === "error"
				? `${label} encountered an error`
				: entry.state === "waiting"
					? `${label} needs your input`
					: `${label} is ready`;

		const location = paneId ? findPaneLocation(paneId) : null;
		const workspaceName = location
			? useWorkspaceStore
					.getState()
					.workspaces.find((w) => w.id === location.workspaceId)?.name
			: undefined;
		try {
			sendNotification({
				title: workspaceName ?? "Abundio",
				body,
				extra:
					location && paneId
						? {
								type: "pty",
								paneId,
								workspaceId: location.workspaceId,
								tabId: location.tabId,
							}
						: { type: "pty" },
			});
		} catch {
			// Notifications may not be permitted
		}
	}
});

// ── Helpers ──

export function collectPtyIds(
	node: PaneNode,
	panePtyMap?: Record<string, string>,
): string[] {
	if (node.type === "terminal") {
		const ptyId = node.ptyId || panePtyMap?.[node.id] || "";
		return ptyId ? [ptyId] : [];
	}
	if (node.type !== "split") return [];
	return [
		...collectPtyIds(node.first, panePtyMap),
		...collectPtyIds(node.second, panePtyMap),
	];
}

// ── Aggregation ──

export type DotStatus =
	| "grey"
	| "green"
	| "amber"
	| "purple"
	| "red"
	| "skyblue";

export function computeWorkspaceDotStatus(
	workspaceId: string,
	tabLayouts: PaneNode[],
	activities: Record<string, PtyActivityEntry>,
	openedWorkspaceIds: Set<string>,
	panePtyMap?: Record<string, string>,
): DotStatus {
	const allPtyIds: string[] = [];
	for (const layout of tabLayouts) {
		allPtyIds.push(...collectPtyIds(layout, panePtyMap));
	}

	if (allPtyIds.length === 0) {
		return openedWorkspaceIds.has(workspaceId) ? "green" : "grey";
	}

	const entries = allPtyIds.map((id) => activities[id]).filter(Boolean);

	if (entries.some((e) => e.state === "error")) return "red";
	if (entries.some((e) => e.state === "waiting")) return "skyblue";
	if (entries.some((e) => e.state === "ready")) return "purple";
	if (entries.some((e) => e.state === "active")) return "amber";

	if (openedWorkspaceIds.has(workspaceId)) return "green";
	return "grey";
}

export function computeTabDotStatus(
	tab: Tab,
	activities: Record<string, PtyActivityEntry>,
	panePtyMap?: Record<string, string>,
): DotStatus {
	let layout: PaneNode;
	try {
		layout = JSON.parse(tab.layoutJson) as PaneNode;
	} catch {
		return "green";
	}

	const ptyIds = collectPtyIds(layout, panePtyMap);
	if (ptyIds.length === 0) return "grey";

	const entries = ptyIds.map((id) => activities[id]).filter(Boolean);

	if (entries.some((e) => e.state === "error")) return "red";
	if (entries.some((e) => e.state === "waiting")) return "skyblue";
	if (entries.some((e) => e.state === "ready")) return "purple";
	if (entries.some((e) => e.state === "active")) return "amber";

	// Tabs are only shown for the active workspace — default to green
	return "green";
}

export function computePtyDotStatus(
	ptyId: string,
	activities: Record<string, PtyActivityEntry>,
): DotStatus {
	const entry = activities[ptyId];
	if (!entry) return "green";

	switch (entry.state) {
		case "active":
			return "amber";
		case "waiting":
			return "skyblue";
		case "ready":
			return "purple";
		case "error":
			return "red";
		default:
			return "green";
	}
}

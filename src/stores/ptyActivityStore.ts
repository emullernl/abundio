import { create } from "zustand";
import type {
	PaneNode,
	PtyActivityState,
	PtyDetectionMode,
	Tab,
} from "../lib/types";

// ── Constants ──

export const IDLE_THRESHOLD_MS = 2000;
const SCAN_INTERVAL_MS = 500;

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
 *  Used in agent mode to keep the idle scanner from transitioning "active" → "waiting"
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
}

interface PtyActivityState_Store {
	activities: Record<string, PtyActivityEntry>;
	titles: Record<string, string>;
	panePtyMap: Record<string, string>; // paneId → ptyId
	openedWorkspaceIds: Set<string>;
	agentPtyIds: Set<string>;

	initPty: (ptyId: string, mode?: PtyDetectionMode) => void;
	recordOutput: (ptyId: string) => void;
	recordError: (ptyId: string) => void;
	recordExitSuccess: (ptyId: string) => void;
	markIdle: (ptyId: string) => void;
	clearError: (ptyId: string) => void;
	setAgentPty: (ptyId: string) => void;
	clearAgentPty: (ptyId: string) => void;
	setTitle: (paneId: string, title: string) => void;
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
		openedWorkspaceIds: new Set(),
		agentPtyIds: new Set(),

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
					},
				},
			}));
		},

		markIdle: (ptyId) => {
			const entry = get().activities[ptyId];
			if (!entry || entry.state === "idle" || entry.state === "error") return;
			// Agent mode: never cancel an in-progress "active" state. markIdle
			// is meant to dismiss "waiting"/"error" alerts the user has
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
					},
				},
			}));
		},

		recordExitSuccess: (ptyId) => {
			const entry = get().activities[ptyId];
			if (!entry) return;
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: { ...s.activities[ptyId], state: "waiting" },
				},
			}));
		},

		setAgentPty: (ptyId) => {
			const s = get();
			if (s.agentPtyIds.has(ptyId)) return;
			const newSet = new Set(s.agentPtyIds);
			newSet.add(ptyId);
			// Clear shell command tracking — agent mode doesn't use shell integration
			// sequences, so command_end will never fire to clear this flag.
			shellCommandRunning.delete(ptyId);
			const entry = s.activities[ptyId];
			if (entry) {
				set({
					agentPtyIds: newSet,
					activities: {
						...s.activities,
						[ptyId]: { ...entry, detectionMode: "agent" },
					},
				});
			} else {
				set({ agentPtyIds: newSet });
			}
		},

		clearAgentPty: (ptyId) => {
			const s = get();
			if (!s.agentPtyIds.has(ptyId)) return;
			const newSet = new Set(s.agentPtyIds);
			newSet.delete(ptyId);
			const entry = s.activities[ptyId];
			if (entry) {
				set({
					agentPtyIds: newSet,
					activities: {
						...s.activities,
						[ptyId]: { ...entry, detectionMode: "shell" },
					},
				});
			} else {
				set({ agentPtyIds: newSet });
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
				const newAgentIds = new Set(s.agentPtyIds);
				const changed = newAgentIds.delete(ptyId);
				return changed
					? { activities: rest, agentPtyIds: newAgentIds }
					: { activities: rest };
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

// Cached reverse map: only rebuilt when panePtyMap reference changes
let _cachedPanePtyMapRef: Record<string, string> | null = null;
let _cachedPtyToPaneMap: Record<string, string> = {};

setInterval(() => {
	const { activities, panePtyMap } = usePtyActivityStore.getState();
	const now = Date.now();
	const updates: Record<string, PtyActivityEntry> = {};
	let hasChanges = false;

	// Rebuild reverse map only when panePtyMap has changed (Zustand produces
	// a new object reference on mutation, so === is sufficient)
	if (panePtyMap !== _cachedPanePtyMapRef) {
		_cachedPanePtyMapRef = panePtyMap;
		_cachedPtyToPaneMap = {};
		for (const [paneId, ptyId] of Object.entries(panePtyMap)) {
			_cachedPtyToPaneMap[ptyId] = paneId;
		}
	}

	const focusedPaneId = _getFocusedPaneId?.() ?? null;
	// If the getter hasn't been injected yet, treat every pane as focused
	// so we don't spam "waiting" transitions during startup.
	const focusGetterReady = _getFocusedPaneId !== null;
	const appHasFocus = typeof document !== "undefined" && document.hasFocus();

	for (const [ptyId, entry] of Object.entries(activities)) {
		const lastOutput = lastOutputTimestamps.get(ptyId) ?? entry.lastOutputAt;
		if (lastOutput === null) continue;
		const elapsed = now - lastOutput;

		if (entry.state === "active" && elapsed > IDLE_THRESHOLD_MS) {
			// Don't transition to idle if a shell command is still running
			if (shellCommandRunning.get(ptyId)) continue;
			const paneId = _cachedPtyToPaneMap[ptyId];
			const isFocused =
				!focusGetterReady ||
				(appHasFocus && paneId != null && focusedPaneId === paneId);
			// Agent mode always goes to "waiting" — the agent finished work and
			// is waiting for user input, even when the terminal has focus.
			const nextState =
				isFocused && entry.detectionMode !== "agent" ? "idle" : "waiting";
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

// ── Helpers ──

export function collectPtyIds(
	node: PaneNode,
	panePtyMap?: Record<string, string>,
): string[] {
	if (node.type === "terminal") {
		const ptyId = node.ptyId || panePtyMap?.[node.id] || "";
		return ptyId ? [ptyId] : [];
	}
	return [
		...collectPtyIds(node.first, panePtyMap),
		...collectPtyIds(node.second, panePtyMap),
	];
}

// ── Aggregation ──

export type DotStatus = "grey" | "green" | "amber" | "purple" | "red";

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
	if (entries.some((e) => e.state === "waiting")) return "purple";
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
	if (ptyIds.length === 0) return "green";

	const entries = ptyIds.map((id) => activities[id]).filter(Boolean);

	if (entries.some((e) => e.state === "error")) return "red";
	if (entries.some((e) => e.state === "waiting")) return "purple";
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
			return "purple";
		case "error":
			return "red";
		default:
			return "green";
	}
}

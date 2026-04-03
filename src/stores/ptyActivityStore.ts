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
	openedSessionIds: Set<string>;
	agentPtyIds: Set<string>;

	initPty: (ptyId: string, mode?: PtyDetectionMode) => void;
	recordOutput: (ptyId: string) => void;
	recordError: (ptyId: string) => void;
	recordExitSuccess: (ptyId: string) => void;
	markIdle: (ptyId: string) => void;
	clearError: (ptyId: string) => void;
	setAgentPty: (ptyId: string) => void;
	setTitle: (paneId: string, title: string) => void;
	registerPane: (paneId: string, ptyId: string) => void;
	markSessionOpened: (sessionId: string) => void;
	removePty: (ptyId: string) => void;
	removePane: (paneId: string) => void;
}

// ── Store ──

export const usePtyActivityStore = create<PtyActivityState_Store>(
	(set, get) => ({
		activities: {},
		titles: {},
		panePtyMap: {},
		openedSessionIds: new Set(),
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

		registerPane: (paneId, ptyId) => {
			if (get().panePtyMap[paneId] === ptyId) return;
			set((s) => ({ panePtyMap: { ...s.panePtyMap, [paneId]: ptyId } }));
		},

		setTitle: (paneId, title) => {
			if (get().titles[paneId] === title) return;
			set((s) => ({ titles: { ...s.titles, [paneId]: title } }));
		},

		markSessionOpened: (sessionId) => {
			const s = get();
			if (s.openedSessionIds.has(sessionId)) return;
			set({ openedSessionIds: new Set([...s.openedSessionIds, sessionId]) });
		},

		removePty: (ptyId) => {
			lastOutputTimestamps.delete(ptyId);
			shellCommandRunning.delete(ptyId);
			set((s) => {
				const { [ptyId]: _, ...rest } = s.activities;
				return { activities: rest };
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

setInterval(() => {
	const { activities, panePtyMap } = usePtyActivityStore.getState();
	const now = Date.now();
	const updates: Record<string, PtyActivityEntry> = {};
	let hasChanges = false;

	// Build reverse map: ptyId → paneId
	const ptyToPaneMap: Record<string, string> = {};
	for (const [paneId, ptyId] of Object.entries(panePtyMap)) {
		ptyToPaneMap[ptyId] = paneId;
	}

	const focusedPaneId = _getFocusedPaneId?.() ?? null;
	const appHasFocus = typeof document !== "undefined" && document.hasFocus();

	for (const [ptyId, entry] of Object.entries(activities)) {
		const lastOutput = lastOutputTimestamps.get(ptyId) ?? entry.lastOutputAt;
		if (lastOutput === null) continue;
		const elapsed = now - lastOutput;

		if (entry.state === "active" && elapsed > IDLE_THRESHOLD_MS) {
			// Don't transition to idle if a shell command is still running
			if (shellCommandRunning.get(ptyId)) continue;
			const paneId = ptyToPaneMap[ptyId];
			const isFocused =
				appHasFocus && paneId != null && focusedPaneId === paneId;
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

export function computeSessionDotStatus(
	sessionId: string,
	tabLayouts: PaneNode[],
	activities: Record<string, PtyActivityEntry>,
	openedSessionIds: Set<string>,
	panePtyMap?: Record<string, string>,
): DotStatus {
	const allPtyIds: string[] = [];
	for (const layout of tabLayouts) {
		allPtyIds.push(...collectPtyIds(layout, panePtyMap));
	}

	if (allPtyIds.length === 0) return "grey";

	const entries = allPtyIds.map((id) => activities[id]).filter(Boolean);

	if (entries.some((e) => e.state === "error")) return "red";
	if (entries.some((e) => e.state === "waiting")) return "purple";
	if (entries.some((e) => e.state === "active")) return "amber";

	if (openedSessionIds.has(sessionId)) return "green";
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

	// Tabs are only shown for the active session — default to green
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

// ── Dot color mapping ──

export const DOT_COLORS: Record<DotStatus, string> = {
	grey: "var(--fg-secondary)",
	green: "var(--success)",
	amber: "#F59E0B",
	purple: "#8B5CF6",
	red: "var(--error)",
};

export const DOT_GLOWS: Record<string, string> = {
	amber: "rgba(245, 158, 11, 0.4)",
	purple: "rgba(139, 92, 246, 0.4)",
	red: "rgba(248, 81, 73, 0.4)",
};

export function shouldPulse(status: DotStatus | null): boolean {
	return status === "amber" || status === "red";
}

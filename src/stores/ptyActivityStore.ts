import { create } from "zustand";
import type { PaneNode, PtyActivityState, Tab } from "../lib/types";

// ── Constants ──

const IDLE_THRESHOLD_MS = 2500;
const SETTLED_THRESHOLD_MS = 30000;
const SCAN_INTERVAL_MS = 500;

// ── Types ──

export interface PtyActivityEntry {
	state: PtyActivityState;
	lastOutputAt: number | null;
	hasEverReceivedOutput: boolean;
}

interface PtyActivityState_Store {
	activities: Record<string, PtyActivityEntry>;
	titles: Record<string, string>;
	panePtyMap: Record<string, string>; // paneId → ptyId
	openedSessionIds: Set<string>;

	initPty: (ptyId: string) => void;
	recordOutput: (ptyId: string) => void;
	recordError: (ptyId: string) => void;
	markIdle: (ptyId: string) => void;
	setTitle: (paneId: string, title: string) => void;
	registerPane: (paneId: string, ptyId: string) => void;
	markSessionOpened: (sessionId: string) => void;
	removePty: (ptyId: string) => void;
	removePane: (paneId: string) => void;
}

// ── Store ──

export const usePtyActivityStore = create<PtyActivityState_Store>((set, get) => ({
	activities: {},
	titles: {},
	panePtyMap: {},
	openedSessionIds: new Set(),

	initPty: (ptyId) => {
		if (get().activities[ptyId]) return;
		set((s) => ({
			activities: {
				...s.activities,
				[ptyId]: { state: "idle", lastOutputAt: null, hasEverReceivedOutput: true },
			},
		}));
	},

	recordOutput: (ptyId) => {
		const entry = get().activities[ptyId];
		// Skip set() if already active — this fires on every output chunk
		if (entry?.state === "active") {
			entry.lastOutputAt = Date.now();
			return;
		}
		set((s) => ({
			activities: {
				...s.activities,
				[ptyId]: {
					state: "active",
					lastOutputAt: Date.now(),
					hasEverReceivedOutput: true,
				},
			},
		}));
	},

	markIdle: (ptyId) => {
		const entry = get().activities[ptyId];
		if (!entry || entry.state === "idle") return;
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
					hasEverReceivedOutput: s.activities[ptyId]?.hasEverReceivedOutput ?? false,
				},
			},
		}));
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
}));

// ── Idle scanner ──

setInterval(() => {
	const { activities } = usePtyActivityStore.getState();
	const now = Date.now();
	const updates: Record<string, PtyActivityEntry> = {};
	let hasChanges = false;

	for (const [ptyId, entry] of Object.entries(activities)) {
		if (entry.lastOutputAt === null) continue;
		const elapsed = now - entry.lastOutputAt;

		if (entry.state === "active" && elapsed > IDLE_THRESHOLD_MS) {
			updates[ptyId] = { ...entry, state: "waiting" };
			hasChanges = true;
		} else if (entry.state === "waiting" && elapsed > SETTLED_THRESHOLD_MS) {
			updates[ptyId] = { ...entry, state: "idle" };
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

export function collectPtyIds(node: PaneNode, panePtyMap?: Record<string, string>): string[] {
	if (node.type === "terminal") {
		const ptyId = node.ptyId || panePtyMap?.[node.id] || "";
		return ptyId ? [ptyId] : [];
	}
	return [...collectPtyIds(node.first, panePtyMap), ...collectPtyIds(node.second, panePtyMap)];
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
	if (entries.some((e) => e.state === "active")) return "amber";
	if (entries.some((e) => e.state === "waiting")) return "purple";

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
	if (entries.some((e) => e.state === "active")) return "amber";
	if (entries.some((e) => e.state === "waiting")) return "purple";

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
	blue: "#F59E0B",
	orange: "#8B5CF6",
	red: "var(--error)",
};

export const DOT_GLOWS: Record<string, string> = {
	blue: "rgba(245, 158, 11, 0.4)",
	orange: "rgba(139, 92, 246, 0.4)",
	red: "rgba(248, 81, 73, 0.4)",
};

export function shouldPulse(status: DotStatus | null): boolean {
	return status === "amber" || status === "purple" || status === "red";
}

import { sendNotification } from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { findPaneLocation, isPaneVisible } from "../lib/notificationRouter";
import { parseTabLayout } from "../lib/paneTree";
import {
	type StatusEvent,
	type StatusState,
	type StatusTransition,
	statusReducer,
} from "../lib/statusReducer";
import type {
	PaneNode,
	PtyActivityState,
	PtyDetectionMode,
	Tab,
} from "../lib/types";
import {
	getWindowBlurredMs,
	NOTIFICATION_BLUR_THRESHOLD_MS,
} from "../lib/windowFocus";
import { currentNotificationTitle } from "./profileStore";
import { useWorkspaceStore } from "./workspaceStore";

// ── Constants ──

// Used by DebugActivityMeter for its progress ring; the idle-scan threshold
// itself now lives in statusReducer (IDLE_THRESHOLD_MS / HOOK_IDLE_BACKSTOP_MS).
export const IDLE_THRESHOLD_MS = 2000;
const SCAN_INTERVAL_MS = 2000;

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

// ── Status machine bridge ──
//
// The discrete transition logic lives in the pure `statusReducer`; the store is
// its dispatcher. Each status action method hydrates a reducer StatusState from
// the stored entry + the out-of-band hot maps, reduces, syncs the maps, projects
// back into the legacy `PtyActivityEntry` shape (so every consumer + the pure
// aggregation functions are untouched), and emits a Status transition. See
// docs/plans/status-machine.md.

const LEGACY_STATE: Record<StatusState["state"], PtyActivityState> = {
	idle: "idle",
	working: "active", // canonical → legacy string (rename deferred, CONTEXT.md)
	waiting: "waiting",
	ready: "ready",
	error: "error",
};
const CANONICAL_STATE: Record<PtyActivityState, StatusState["state"]> = {
	idle: "idle",
	active: "working",
	waiting: "waiting",
	ready: "ready",
	error: "error",
};

/** Hydrate a reducer StatusState from the stored entry + the hot maps. The
 *  heuristic / ESC fields are unused by store-level events (terminalManager
 *  still owns the byte heuristic and ESC classification), so they default. */
function hydrate(
	entry: PtyActivityEntry | undefined,
	ptyId: string,
): StatusState {
	return {
		state: entry ? CANONICAL_STATE[entry.state] : "idle",
		mode: entry?.detectionMode ?? "shell",
		hookDriven: entry?.hookDriven ?? false,
		workingSince: entry?.lastOutputAt ?? null,
		lastActivityAt:
			lastOutputTimestamps.get(ptyId) ?? entry?.lastOutputAt ?? null,
		shellCommandRunning: shellCommandRunning.get(ptyId) ?? false,
		bytesSinceIdle: 0,
		thresholdHitTimes: [],
		lastInputAt: 0,
		lastOutputChunkAt: null,
		lastEscAt: null,
	};
}

function project(
	st: StatusState,
	prev: PtyActivityEntry | undefined,
): PtyActivityEntry {
	return {
		state: LEGACY_STATE[st.state],
		lastOutputAt: st.workingSince,
		hasEverReceivedOutput: prev?.hasEverReceivedOutput ?? true,
		detectionMode: st.mode,
		hookDriven: st.hookDriven,
	};
}

function entriesEqual(a: PtyActivityEntry, b: PtyActivityEntry): boolean {
	return (
		a.state === b.state &&
		a.lastOutputAt === b.lastOutputAt &&
		a.hasEverReceivedOutput === b.hasEverReceivedOutput &&
		a.detectionMode === b.detectionMode &&
		a.hookDriven === b.hookDriven
	);
}

// ── Status transition output seam ──
// Emitted whenever a PTY's status tuple changes, carrying the cause in-band.
// Consumed by notifications and Turn telemetry (see docs/plans/status-machine.md).

export interface StatusSnapshot {
	state: PtyActivityState;
	detectionMode: PtyDetectionMode;
	hookDriven: boolean;
}
export interface StatusChange {
	ptyId: string;
	prev: StatusSnapshot;
	next: StatusSnapshot;
	cause: StatusEvent;
}

const statusChangeListeners = new Set<(c: StatusChange) => void>();

/** Subscribe to Status transitions. Returns an unsubscribe fn. */
export function subscribeStatusChange(
	fn: (c: StatusChange) => void,
): () => void {
	statusChangeListeners.add(fn);
	return () => statusChangeListeners.delete(fn);
}

function emitStatusChange(c: StatusChange): void {
	for (const fn of statusChangeListeners) {
		try {
			fn(c);
		} catch (err) {
			console.error("[statusChange] listener failed:", err);
		}
	}
}

function snap(e: PtyActivityEntry): StatusSnapshot {
	return {
		state: e.state,
		detectionMode: e.detectionMode,
		hookDriven: e.hookDriven,
	};
}

/** Apply one reducer event to a PTY: reduce, sync the hot maps, project back
 *  into `activities` (skipping the write when the projected entry is unchanged —
 *  preserving the hot-path no-re-render), and emit a StatusChange on a real tuple
 *  change. `extra` folds identity-set mutations into the same set(). */
function applyStatusEvent(
	ptyId: string,
	event: StatusEvent,
	extra?: Partial<PtyActivityState_Store>,
): void {
	const prevEntry = usePtyActivityStore.getState().activities[ptyId];
	const before = hydrate(prevEntry, ptyId);
	const after = statusReducer(before, event);

	// Sync the out-of-band hot maps from the reducer result.
	if (after.lastActivityAt !== null) {
		lastOutputTimestamps.set(ptyId, after.lastActivityAt);
	}
	if (after.shellCommandRunning) shellCommandRunning.set(ptyId, true);
	else shellCommandRunning.delete(ptyId);

	const nextEntry = project(after, prevEntry);
	const changed = !prevEntry || !entriesEqual(prevEntry, nextEntry);

	if (extra || changed) {
		usePtyActivityStore.setState((s) => ({
			...(extra ?? {}),
			...(changed
				? { activities: { ...s.activities, [ptyId]: nextEntry } }
				: {}),
		}));
	}
	if (changed) {
		const prevSnap = snap(prevEntry ?? project(before, undefined));
		emitStatusChange({
			ptyId,
			prev: prevSnap,
			next: snap(nextEntry),
			cause: event,
		});
	}
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
			// The reducer holds the ADR-0015 Waiting guard and the already-Working
			// short-circuit; applyStatusEvent skips the set() (and the re-render)
			// when the projected entry is unchanged, only bumping the hot map.
			applyStatusEvent(ptyId, { kind: "recordOutput", now: Date.now() });
		},

		markIdle: (ptyId) => {
			// markIdle == the reducer's `focus` event: dismiss an acknowledged
			// Ready/Error-shell alert, but never cancel a Working agent, a Waiting
			// agent, or a running shell command. All those guards live in the reducer.
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "focus" });
		},

		clearError: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "clearError" });
		},

		recordError: (ptyId) => {
			// No guard: a recordError on an absent PTY creates the Error entry
			// (mirrors the old unconditional set()).
			applyStatusEvent(ptyId, { kind: "recordError" });
		},

		applyHookEvent: (ptyId, transition) => {
			if (!get().activities[ptyId]) return;
			// The store's legacy "active" maps to the reducer's canonical "working".
			const t: StatusTransition =
				transition === "active" ? "working" : transition;
			applyStatusEvent(ptyId, { kind: "hook", transition: t, now: Date.now() });
		},

		clearWaiting: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "clearWaiting" });
		},

		clearActive: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "clearActive" });
		},

		recordExitSuccess: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "recordExitSuccess" });
		},

		setAgentPty: (ptyId, agentId) => {
			const s = get();
			if (s.agentPtyIds.has(ptyId)) {
				// Already in agent mode — but the auto-launch path marks the PTY as
				// an agent WITHOUT an id (it only knows the command string, not which
				// Agent — see terminalManager `takePendingAgent`). The id-bearing
				// detection that follows (a `command_start` title match or the first
				// Agent hook) must still be able to record it; otherwise
				// `detectedAgentIds` stays empty, the titlebar keeps the terminal icon
				// instead of the Agent's, and the Turn tracker can't resolve the Agent
				// so no Turns are recorded. Backfill the id without re-running the
				// agentDetected transition (mode is already agent).
				if (agentId && s.detectedAgentIds[ptyId] !== agentId) {
					set({
						detectedAgentIds: { ...s.detectedAgentIds, [ptyId]: agentId },
					});
				}
				return;
			}
			const newSet = new Set(s.agentPtyIds);
			newSet.add(ptyId);
			// Clear shell command tracking — agent mode doesn't use shell integration
			// sequences, so command_end will never fire to clear this flag.
			shellCommandRunning.delete(ptyId);
			const detectedUpdate = agentId
				? { detectedAgentIds: { ...s.detectedAgentIds, [ptyId]: agentId } }
				: {};
			if (s.activities[ptyId]) {
				applyStatusEvent(
					ptyId,
					{ kind: "agentDetected" },
					{ agentPtyIds: newSet, ...detectedUpdate },
				);
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
			if (s.activities[ptyId]) {
				applyStatusEvent(
					ptyId,
					{ kind: "sessionEnded" },
					{ agentPtyIds: newSet, detectedAgentIds: restDetected },
				);
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

// Cached reverse map: only rebuilt when panePtyMap reference changes. Used
// by the notifications subscriber (hottest path — fires on every recordOutput
// / setCwd / setTitle / setRunningCommand). The previous
// Object.entries(...).find(...) reverse lookup in the subscriber was
// O(panes) per state change.
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
	const { activities } = usePtyActivityStore.getState();
	const now = Date.now();
	const updates: Record<string, PtyActivityEntry> = {};
	const changes: StatusChange[] = [];

	for (const [ptyId, entry] of Object.entries(activities)) {
		// The reducer's Tick holds the whole idle-scan rule: only a stuck Working
		// PTY transitions, with the hook-driven backstop vs heuristic threshold,
		// the shell-command guard, and agent→Ready / shell→Idle (ADR-0009).
		const before = hydrate(entry, ptyId);
		const after = statusReducer(before, { kind: "tick", now });
		if (after.state === before.state) continue;
		const nextEntry = project(after, entry);
		updates[ptyId] = nextEntry;
		changes.push({
			ptyId,
			prev: snap(entry),
			next: snap(nextEntry),
			cause: { kind: "tick", now },
		});
	}

	if (changes.length > 0) {
		usePtyActivityStore.setState((s) => ({
			activities: { ...s.activities, ...updates },
		}));
		for (const c of changes) emitStatusChange(c);
	}
}, SCAN_INTERVAL_MS);

// ── Notifications for state transitions ──
//
// Consumes the Status transition output seam: each StatusChange names the one
// PTY that moved and carries its prev/next, so the per-pty diff the old
// store.subscribe did by scanning all activities is now implicit. See
// docs/plans/status-machine.md.

subscribeStatusChange(({ ptyId, prev, next }) => {
	if (prev.state === next.state) return; // a mode-only change (e.g. sessionEnded)
	if (
		next.state !== "ready" &&
		next.state !== "error" &&
		next.state !== "waiting"
	)
		return;

	const { titles, panePtyMap } = usePtyActivityStore.getState();
	const blurredMs = getWindowBlurredMs();
	const windowAwayLongEnough =
		blurredMs !== null && blurredMs >= NOTIFICATION_BLUR_THRESHOLD_MS;
	const paneId = getPtyToPaneMap(panePtyMap)[ptyId];

	// "waiting" (agent blocked on the user) notifies whenever the pane is not on
	// screen — window blurred OR the pane is in a background tab/workspace.
	// "ready"/"error" keep the blurred-only gate.
	const shouldNotify =
		next.state === "waiting"
			? windowAwayLongEnough || !paneId || !isPaneVisible(paneId)
			: windowAwayLongEnough;
	if (!shouldNotify) return;

	const title = paneId ? titles[paneId] : undefined;
	const label =
		title || (next.detectionMode === "agent" ? "Agent" : "Terminal");
	const baseBody =
		next.state === "error"
			? `${label} encountered an error`
			: next.state === "waiting"
				? `${label} needs your input`
				: `${label} is ready`;

	const location = paneId ? findPaneLocation(paneId) : null;
	const workspaceName = location
		? useWorkspaceStore
				.getState()
				.workspaces.find((w) => w.id === location.workspaceId)?.name
		: undefined;
	// Title uses the profile-qualified format (matches the window title);
	// workspace context that previously lived in the title is folded into the
	// body so it isn't lost.
	const body = workspaceName ? `${workspaceName}: ${baseBody}` : baseBody;
	try {
		sendNotification({
			title: currentNotificationTitle(),
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
	| "cyan"
	| "purple"
	| "red"
	| "skyblue";

/** Asymmetric rollup: agent-mode PTYs propagate every state to the
 *  Tab/Workspace dot; shell-mode PTYs propagate only Error. Working, Ready
 *  (unreachable for shells but defensive) and Waiting from a shell are
 *  suppressed so a backgrounded `npm run dev` doesn't permanently colour its
 *  Tab dot. See ADR-0009. */
function rollsUp(entry: PtyActivityEntry): boolean {
	if (entry.detectionMode === "agent") return true;
	return entry.state === "error";
}

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

	const entries = allPtyIds
		.map((id) => activities[id])
		.filter((e): e is PtyActivityEntry => Boolean(e))
		.filter(rollsUp);

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
	const layout = parseTabLayout(tab.layoutJson);
	if (!layout) return "green";

	const ptyIds = collectPtyIds(layout, panePtyMap);
	if (ptyIds.length === 0) return "grey";

	const entries = ptyIds
		.map((id) => activities[id])
		.filter((e): e is PtyActivityEntry => Boolean(e))
		.filter(rollsUp);

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
			// Working amber for an Agent (attention-worthy mid-turn), cyan for a
			// shell-mode PTY (neutral throughput — you started the command, no
			// alarm needed). See ADR-0009.
			return entry.detectionMode === "agent" ? "amber" : "cyan";
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

// ── Agent state count selectors ──
// One per Agent state, returning a primitive so Zustand's default Object.is
// equality bails re-render unless the count actually changed. Used by the
// Overview bar. The internal state string `"active"` maps to the glossary
// term Working (see CONTEXT.md).

type AgentCountSelectorState = {
	agentPtyIds: Set<string>;
	activities: Record<string, PtyActivityEntry>;
};

function makeAgentCountSelector(target: PtyActivityState) {
	return (s: AgentCountSelectorState): number => {
		let n = 0;
		for (const id of s.agentPtyIds) {
			if (s.activities[id]?.state === target) n++;
		}
		return n;
	};
}

export const selectIdleAgentCount = makeAgentCountSelector("idle");
export const selectWorkingAgentCount = makeAgentCountSelector("active");
export const selectWaitingAgentCount = makeAgentCountSelector("waiting");
export const selectReadyAgentCount = makeAgentCountSelector("ready");
export const selectErrorAgentCount = makeAgentCountSelector("error");

// Shell-mode counterparts: a PTY is shell-mode iff it's NOT in agentPtyIds.
// Iterating the activities map and skipping agents covers shell PTYs whether
// or not they've ever flipped through agent mode this session.

function makeShellCountSelector(target: PtyActivityState) {
	return (s: AgentCountSelectorState): number => {
		let n = 0;
		for (const ptyId of Object.keys(s.activities)) {
			if (s.agentPtyIds.has(ptyId)) continue;
			if (s.activities[ptyId]?.state === target) n++;
		}
		return n;
	};
}

// Shell-mode PTYs only ever occupy Idle / Working / Error — Ready is
// agent-only (see ADR-0009). No `selectReadyShellCount` exists.
export const selectIdleShellCount = makeShellCountSelector("idle");
export const selectWorkingShellCount = makeShellCountSelector("active");
export const selectErrorShellCount = makeShellCountSelector("error");

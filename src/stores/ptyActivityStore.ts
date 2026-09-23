import { sendNotification } from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { findPaneLocation, isPaneVisible } from "../lib/notificationRouter";
import { parseTabLayout } from "../lib/paneTree";
import {
	NO_SUBAGENTS,
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

// Live Subagents + the "Stop held" flag per PTY (ADR-0022,
// docs/plans/subagent-aware-status.md). Stored outside Zustand like the maps
// above: per-Start/Stop churn must not re-render — only the resulting state
// flips do. The Stage-2 dispatcher absorbs this map with the others.
const subagentState = new Map<
	string,
	{
		subagents: ReadonlyArray<{ id: string; startedAt: number }>;
		stopHeld: boolean;
	}
>();

// What a PTY was doing when a **Mid-turn failure** turned it red (ADR-0026).
// Out-of-band like the maps above rather than a `PtyActivityEntry` field: it is
// read only by `clearError` and the keystroke handler, and putting it in the
// entry would ripple through project/entriesEqual/snap and emit same-state
// StatusChanges. Non-null only while the entry state is "error".
const preErrorStates = new Map<string, "working" | "waiting">();

/** What the pane was doing before a **Mid-turn failure**, or null if the red
 *  icon came from a **Turn failure** (or the PTY isn't in Error at all). Lets
 *  the keystroke handler give a key the meaning it would have had without the
 *  failure — answering a permission prompt still answers it. See ADR-0026. */
export function peekPreErrorState(ptyId: string): "working" | "waiting" | null {
	return preErrorStates.get(ptyId) ?? null;
}

/** Whether `id` is a live Subagent of this PTY — used by the translator to
 *  route OpenCode child-session events (their `session.idle` payload carries
 *  no `parentID`, so set membership is the discriminator). */
export function hasActiveSubagent(ptyId: string, id: string): boolean {
	return subagentState.get(ptyId)?.subagents.some((s) => s.id === id) ?? false;
}

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

// ── Types ──

export interface PtyActivityEntry {
	state: PtyActivityState;
	lastOutputAt: number | null;
	hasEverReceivedOutput: boolean;
	detectionMode: PtyDetectionMode;
	// True once an Agent hook event has driven this PTY's state. Hook events
	// are authoritative, so the byte-accumulation heuristic backs off.
	hookDriven: boolean;
	/** A shell command is in flight (between `command_start` and `command_end`).
	 *  Lives on the entry rather than in an out-of-band map so that the one
	 *  question "is this terminal busy?" has one answer: the **Status
	 *  indicator** and the close confirmations both read it from here, and a
	 *  **Busy PTY** is a pure function of this object. Also what suppresses the
	 *  idle backstop, so a long *silent* build keeps counting as busy
	 *  (`reduceTick`). See ADR-0034. */
	shellCommandRunning: boolean;
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
	setShellCommandRunning: (ptyId: string, running: boolean) => void;
	recordError: (ptyId: string) => void;
	recordExitSuccess: (ptyId: string) => void;
	markIdle: (ptyId: string) => void;
	clearError: (ptyId: string) => void;
	click: (ptyId: string) => void;
	applyHookEvent: (
		ptyId: string,
		transition:
			| "active"
			| "waiting"
			| "ready"
			| "idle"
			| "error"
			| "errorMidTurn"
			| "resume"
			| "attach",
		startsTurn?: boolean,
	) => void;
	clearWaiting: (ptyId: string) => void;
	clearActive: (ptyId: string) => void;
	subagentStarted: (ptyId: string, agentId: string) => void;
	subagentStopped: (ptyId: string, agentId: string) => void;
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
		shellCommandRunning: entry?.shellCommandRunning ?? false,
		bytesSinceIdle: 0,
		thresholdHitTimes: [],
		lastInputAt: 0,
		lastOutputChunkAt: null,
		lastEscAt: null,
		activeSubagents: subagentState.get(ptyId)?.subagents ?? NO_SUBAGENTS,
		stopHeldForSubagents: subagentState.get(ptyId)?.stopHeld ?? false,
		preErrorState: preErrorStates.get(ptyId) ?? null,
	};
}

/** Sync the out-of-band Subagent map from a reducer result (delete on the
 *  trivial empty+unheld state — mirrors `shellCommandRunning` hygiene). */
function syncSubagentState(ptyId: string, after: StatusState): void {
	if (after.activeSubagents.length > 0 || after.stopHeldForSubagents) {
		subagentState.set(ptyId, {
			subagents: after.activeSubagents,
			stopHeld: after.stopHeldForSubagents,
		});
	} else {
		subagentState.delete(ptyId);
	}
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
		shellCommandRunning: st.shellCommandRunning,
	};
}

function entriesEqual(a: PtyActivityEntry, b: PtyActivityEntry): boolean {
	return (
		a.state === b.state &&
		a.lastOutputAt === b.lastOutputAt &&
		a.hasEverReceivedOutput === b.hasEverReceivedOutput &&
		a.detectionMode === b.detectionMode &&
		a.hookDriven === b.hookDriven &&
		// Must be compared, or the write-skip would leave the store's copy stale
		// while the reducer's stayed fresh — the exact drift moving this field
		// onto the entry exists to remove (ADR-0034).
		a.shellCommandRunning === b.shellCommandRunning
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

/** Which Working→Ready backstop a scanner tick trips, given the pane's state
 *  *before* the tick. Live Subagents mean the drain path: a turn-finished hook
 *  was observed and merely held for the tail (ADR-0022). Anything else is pure
 *  silence, whose boundary is a **Presumed end** (ADR-0027). Only the scanner
 *  holds `before`, which is why the answer must ride the cause rather than be
 *  re-derived downstream. */
export function backstopRule(
	before: Pick<StatusState, "activeSubagents">,
): "idle_backstop" | "subagent_drain" {
	return before.activeSubagents.length > 0 ? "subagent_drain" : "idle_backstop";
}

/** Test-only: publish a Status transition without going through a real event. */
export function __emitStatusChangeForTests(c: StatusChange): void {
	emitStatusChange(c);
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
	syncSubagentState(ptyId, after);
	if (after.preErrorState !== null) {
		preErrorStates.set(ptyId, after.preErrorState);
	} else {
		preErrorStates.delete(ptyId);
	}

	const nextEntry = project(after, prevEntry);
	const changed = !prevEntry || !entriesEqual(prevEntry, nextEntry);

	// A turn-start hook is a **Turn** boundary whether or not the icon moves, so it
	// must reach the seam even when the projected entry is identical — Turn
	// telemetry has no other way to learn a new Turn began. This used to hold only
	// by luck: the known case (a command-detected Agent whose TUI flood tripped the
	// byte heuristic into Working before its first hook) also flipped `hookDriven`,
	// so the entry changed. On an already-hook-driven pane sitting at Working it
	// emitted nothing, and the whole next Turn went unrecorded — reachable via a
	// **Mid-turn failure** acknowledged back to Working, or simply a queued prompt.
	//
	// Gated on `startsTurn` (from `isTurnStartEvent`), NOT on the transition: a
	// permission reply also resolves to Working and is not a boundary. The one
	// hot case left is OpenCode, whose only Working signal is per-token streaming
	// (see TURN_START_EVENTS) — there this forces an emission per delta. That
	// stays behaviourally inert (the tracker no-ops on an open Turn and the
	// notification subscriber early-returns on an unchanged state); the cost is
	// two `snap()` allocations and a listener walk.
	const isTurnStart = event.kind === "hook" && event.startsTurn === true;

	if (extra || changed) {
		usePtyActivityStore.setState((s) => ({
			...(extra ?? {}),
			...(changed
				? { activities: { ...s.activities, [ptyId]: nextEntry } }
				: {}),
		}));
	}
	if (changed || isTurnStart) {
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
			// A fresh entry starts Idle, so the mid-turn-failure memory must not
			// survive into it (the invariant is: non-null only while Error). This
			// set() bypasses applyStatusEvent, so clear it by hand.
			preErrorStates.delete(ptyId);
			set((s) => ({
				activities: {
					...s.activities,
					[ptyId]: {
						state: "idle",
						lastOutputAt: null,
						hasEverReceivedOutput: true,
						detectionMode: mode ?? "shell",
						hookDriven: false,
						shellCommandRunning: false,
					},
				},
			}));
		},

		setShellCommandRunning: (ptyId, running) => {
			// Deliberately not a reducer event: this only records *that* a command
			// is in flight. The status moves that go with it (recordOutput on
			// start, recordError / recordExitSuccess on end) are dispatched by
			// terminalManager, which is the only caller and the only place that
			// knows the exit code. Skips the set() when unchanged, preserving the
			// hot-path no-re-render the out-of-band map used to give.
			set((s) => {
				const entry = s.activities[ptyId];
				if (!entry || entry.shellCommandRunning === running) return s;
				return {
					activities: {
						...s.activities,
						[ptyId]: { ...entry, shellCommandRunning: running },
					},
				};
			});
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

		click: (ptyId) => {
			// A deliberate left-click on the terminal screen, as ONE event. The
			// reducer's `click` runs clearWaiting → clearError → markIdle in that
			// order, which matters: clearWaiting must see the Error state (where it
			// no-ops) so a **Mid-turn failure** restored to Waiting survives the
			// click — the Agent really is still blocked, and a click is not an
			// answer (ADR-0026). Dispatching the three separately, from two
			// different handlers, is what inverted that order and dropped a restored
			// Waiting straight to Idle.
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "click" });
		},

		recordError: (ptyId) => {
			// No guard: a recordError on an absent PTY creates the Error entry
			// (mirrors the old unconditional set()).
			applyStatusEvent(ptyId, { kind: "recordError" });
		},

		applyHookEvent: (ptyId, transition, startsTurn) => {
			if (!get().activities[ptyId]) return;
			// The store's legacy "active" maps to the reducer's canonical "working".
			const t: StatusTransition =
				transition === "active" ? "working" : transition;
			applyStatusEvent(ptyId, {
				kind: "hook",
				transition: t,
				now: Date.now(),
				startsTurn,
			});
		},

		clearWaiting: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "clearWaiting" });
		},

		clearActive: (ptyId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, { kind: "clearActive" });
		},

		subagentStarted: (ptyId, agentId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, {
				kind: "subagentStarted",
				agentId,
				now: Date.now(),
			});
		},

		subagentStopped: (ptyId, agentId) => {
			if (!get().activities[ptyId]) return;
			applyStatusEvent(ptyId, {
				kind: "subagentStopped",
				agentId,
				now: Date.now(),
			});
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
			// Shell command tracking is cleared by the `agentDetected` event below:
			// agent mode doesn't use shell integration sequences, so command_end
			// will never fire to clear the flag.
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
					{ kind: "agentExited" },
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
			subagentState.delete(ptyId);
			preErrorStates.delete(ptyId);
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
		// The stale-Subagent prune can shrink the set WITHOUT a state flip — sync
		// the out-of-band map before the equal-state early-continue (ADR-0022).
		if (after.activeSubagents !== before.activeSubagents) {
			syncSubagentState(ptyId, after);
		}
		if (after.state === before.state) continue;
		const nextEntry = project(after, entry);
		updates[ptyId] = nextEntry;
		changes.push({
			ptyId,
			prev: snap(entry),
			next: snap(nextEntry),
			// Name which backstop this tick tripped. Only the scanner holds
			// `before`, so only the scanner can tell them apart: a pane with live
			// Subagents took the drain path (a turn-finished hook was observed and
			// merely held, ADR-0022); anything else is pure silence and its boundary
			// is a **Presumed end** (ADR-0027).
			cause: { kind: "tick", now, rule: backstopRule(before) },
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

subscribeStatusChange(({ ptyId, prev, next, cause }) => {
	if (prev.state === next.state) return; // a mode-only change (e.g. agentExited)
	// A **Mid-turn failure** is not worth pulling the user back to the machine:
	// the Agent is still generating and an agentStop will follow, so this would
	// be the first of two pings for one Turn — and the alarming one is the one
	// the Agent handles itself. Turn failures still notify (ADR-0026).
	if (cause.kind === "hook" && cause.transition === "errorMidTurn") return;
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

/** Precedence over already-computed statuses, highest-attention first. Used
 *  wherever two statuses must collapse into one — the narrow sidebar's single
 *  Hidden-rollup badge, and a hidden worktree's line in its tooltip. */
const DOT_STATUS_PRECEDENCE: DotStatus[] = [
	"red",
	"skyblue",
	"purple",
	"amber",
	"cyan",
	"green",
	"grey",
];

export function rollupDotStatus(statuses: DotStatus[]): DotStatus {
	for (const candidate of DOT_STATUS_PRECEDENCE) {
		if (statuses.includes(candidate)) return candidate;
	}
	return "grey";
}

/** Human label for a status, for tooltips. Mirrors the Overview bar's wording. */
export function dotStatusLabel(status: DotStatus): string {
	switch (status) {
		case "red":
			return "Error";
		case "skyblue":
			return "Waiting";
		case "purple":
			return "Ready";
		case "amber":
			return "Working";
		case "cyan":
			return "Shell running";
		case "green":
			return "Idle";
		case "grey":
			return "Not opened";
	}
}

// A Tab or Workspace carries two rollups, never one mixed icon: the **Agent
// rollup** over its agent-mode PTYs and the **Terminal rollup** over its
// shell-mode PTYs. A rollup with no PTYs of its kind is `null` — drawn as no
// icon, not as Idle. See ADR-0032 and CONTEXT.md.

export type RollupKind = "agent" | "terminal";

/** How many PTYs of one kind sit in each state. */
export interface StatusCounts {
	error: number;
	waiting: number;
	ready: number;
	working: number;
	idle: number;
}

export interface KindRollup {
	status: DotStatus;
	counts: StatusCounts;
}

export interface Rollups {
	agent: KindRollup | null;
	terminal: KindRollup | null;
}

export interface WorkspaceRollups extends Rollups {
	/** Never opened in this Window and nothing to report: drawn as the single
	 *  grey "Not opened" icon, with both rollups `null`. */
	notOpened: boolean;
}

/** Most urgent first — the order of both the precedence and the tooltip. */
const COUNT_ORDER: Array<[keyof StatusCounts, string]> = [
	["error", "Error"],
	["waiting", "Waiting"],
	["ready", "Ready"],
	["working", "Working"],
	["idle", "Idle"],
];

function emptyCounts(): StatusCounts {
	return { error: 0, waiting: 0, ready: 0, working: 0, idle: 0 };
}

function countKey(state: PtyActivityState): keyof StatusCounts {
	return state === "active" ? "working" : state;
}

function totalOf(counts: StatusCounts): number {
	return (
		counts.error + counts.waiting + counts.ready + counts.working + counts.idle
	);
}

/** The status a rollup draws. Working is amber for Agents and cyan for
 *  terminals, as at the pane (ADR-0009). Shells never reach Waiting or Ready,
 *  but they are ranked here rather than silently dropped. */
function statusOfCounts(kind: RollupKind, counts: StatusCounts): DotStatus {
	if (counts.error > 0) return "red";
	if (counts.waiting > 0) return "skyblue";
	if (counts.ready > 0) return "purple";
	if (counts.working > 0) return kind === "agent" ? "amber" : "cyan";
	return "green";
}

function rollupOf(kind: RollupKind, counts: StatusCounts): KindRollup | null {
	if (totalOf(counts) === 0) return null;
	return { status: statusOfCounts(kind, counts), counts };
}

function tallyEntries(entries: PtyActivityEntry[]): Rollups {
	const agent = emptyCounts();
	const terminal = emptyCounts();
	for (const entry of entries) {
		const counts = entry.detectionMode === "agent" ? agent : terminal;
		counts[countKey(entry.state)]++;
	}
	return {
		agent: rollupOf("agent", agent),
		terminal: rollupOf("terminal", terminal),
	};
}

function entriesFor(
	ptyIds: string[],
	activities: Record<string, PtyActivityEntry>,
): PtyActivityEntry[] {
	return ptyIds
		.map((id) => activities[id])
		.filter((e): e is PtyActivityEntry => Boolean(e));
}

/** Sums several sets of rollups into one — the **Hidden rollup** across a
 *  Folded set's hidden members. */
export function mergeRollups(list: Rollups[]): Rollups {
	const sum = (kind: RollupKind): KindRollup | null => {
		const counts = emptyCounts();
		for (const r of list) {
			const part = r[kind];
			if (!part) continue;
			for (const [key] of COUNT_ORDER) counts[key] += part.counts[key];
		}
		return rollupOf(kind, counts);
	};
	return { agent: sum("agent"), terminal: sum("terminal") };
}

/** The more urgent of the two rollups, for places with room for one icon
 *  only. `grey` when there is nothing to report. */
export function mostUrgentStatus(rollups: Rollups): DotStatus {
	const present: DotStatus[] = [];
	if (rollups.agent) present.push(rollups.agent.status);
	if (rollups.terminal) present.push(rollups.terminal.status);
	return rollupDotStatus(present);
}

/** Hover text for one rollup icon: its full breakdown, most urgent first,
 *  zero counts left out — e.g. "Agents: 2 Waiting · 1 Working · 3 Idle". */
export function rollupTooltip(kind: RollupKind, counts: StatusCounts): string {
	const parts = COUNT_ORDER.filter(([key]) => counts[key] > 0).map(
		([key, label]) => `${counts[key]} ${label}`,
	);
	return `${kind === "agent" ? "Agents" : "Terminals"}: ${parts.join(" · ")}`;
}

// ── Rollup keys ──
// Components subscribe to a rollup through a string key rather than the
// object: the store changes on every status transition anywhere, and a
// primitive lets Zustand's default equality skip the re-render unless this
// rollup changed. Fixed shape, so a hand-rolled format is both cheaper than
// JSON and exact: `<n|o>|<agent>|<terminal>`, each rollup `-` or
// `status:error,waiting,ready,working,idle`.

function encodeKind(r: KindRollup | null): string {
	if (!r) return "-";
	const c = r.counts;
	return `${r.status}:${c.error},${c.waiting},${c.ready},${c.working},${c.idle}`;
}

function decodeKind(key: string): KindRollup | null {
	if (key === "-") return null;
	const [status, nums] = key.split(":");
	const [error, waiting, ready, working, idle] = nums.split(",").map(Number);
	return {
		status: status as DotStatus,
		counts: { error, waiting, ready, working, idle },
	};
}

/** Encodes rollups as a primitive store-selector key. A Tab's rollups have
 *  no `notOpened` and encode as opened. */
export function encodeRollups(r: Rollups & { notOpened?: boolean }): string {
	return `${r.notOpened ? "n" : "o"}|${encodeKind(r.agent)}|${encodeKind(r.terminal)}`;
}

/** The inverse of `encodeRollups`. */
export function decodeRollups(key: string): WorkspaceRollups {
	const [flag, agent, terminal] = key.split("|");
	return {
		agent: decodeKind(agent),
		terminal: decodeKind(terminal),
		notOpened: flag === "n",
	};
}

export function computeWorkspaceRollups(
	workspaceId: string,
	tabLayouts: PaneNode[],
	activities: Record<string, PtyActivityEntry>,
	openedWorkspaceIds: Set<string>,
	panePtyMap?: Record<string, string>,
): WorkspaceRollups {
	const ptyIds: string[] = [];
	for (const layout of tabLayouts) {
		ptyIds.push(...collectPtyIds(layout, panePtyMap));
	}
	const rollups = tallyEntries(entriesFor(ptyIds, activities));
	// A Workspace not opened in this Window reads "Not opened" unless one of its
	// PTYs has something worth saying anyway. `grey` here means no PTYs at all,
	// `green` means all of them idle — neither is worth saying.
	const urgent = mostUrgentStatus(rollups);
	if (
		!openedWorkspaceIds.has(workspaceId) &&
		(urgent === "green" || urgent === "grey")
	) {
		return { agent: null, terminal: null, notOpened: true };
	}
	return { ...rollups, notOpened: false };
}

export function computeTabRollups(
	tab: Tab,
	activities: Record<string, PtyActivityEntry>,
	panePtyMap?: Record<string, string>,
): Rollups {
	const layout = parseTabLayout(tab.layoutJson);
	if (!layout) return { agent: null, terminal: null };
	return tallyEntries(
		entriesFor(collectPtyIds(layout, panePtyMap), activities),
	);
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

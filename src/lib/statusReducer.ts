// Status machine — the pure reducer at the heart of PTY status derivation.
//
// `statusReducer(state, event) → state` is the SINGLE home for every transition
// between the Status-indicator states (Idle / Working / Waiting / Ready / Error).
// It is pure: no clock (time arrives on the event), no IPC, no DOM, no store — so
// every documented behaviour (ADR-0009 agent/shell asymmetry, ADR-0015 Waiting
// guard, ESC cancel, the idle backstop) is a table test. See
// docs/plans/status-machine.md and CONTEXT.md (Status machine / Status event).
//
// This module is wired to nothing in Stage 1 — it is built and tested in
// isolation against the behaviour the scattered code currently produces
// (ptyActivityStore's action methods + idle scanner, plus terminalManager's
// inline transition decisions). Stage 2 makes a dispatcher feed it.
//
// State names are the canonical glossary terms (Working, not the legacy
// `"active"`); the dispatcher bridges `working → "active"` at the store boundary
// until the app-wide rename lands.

import { classifyShellExit, recordThresholdHit } from "./activityGate";

export type StatusDotState = "idle" | "working" | "waiting" | "ready" | "error";
export type StatusMode = "agent" | "shell";

/** A hook-driven transition, as resolved by `mapHookEvent` on the translator
 *  side (the "clear" transition is modelled as the `sessionEnded` event). */
export type StatusTransition = "working" | "waiting" | "ready" | "error";

/** A keystroke pre-classified by the translator (after focus/mouse-report
 *  filtering). `answer` = Enter or a 0-9 choice; `esc` = a bare ESC. */
export type KeystrokeKey = "esc" | "answer" | "other";

export interface StatusState {
	state: StatusDotState;
	mode: StatusMode;
	/** True once a hook event has driven this PTY. Hook events are authoritative,
	 *  so the byte heuristic backs off and the idle scan uses a far longer
	 *  backstop. Mirrors the old `PtyActivityEntry.hookDriven`. */
	hookDriven: boolean;
	/** When the current Working stretch began (the "active window" start). Idle-
	 *  scan fallback. Mirrors the old `PtyActivityEntry.lastOutputAt`. */
	workingSince: number | null;
	/** Last moment any activity was seen — bumped on every output chunk even
	 *  while already Working/Waiting, so the backstop sees fresh output. Primary
	 *  idle-scan input. Mirrors the old out-of-band `lastOutputTimestamps`. */
	lastActivityAt: number | null;
	/** A shell command is in flight (between start and end). Blocks the idle
	 *  scan. Mirrors the old out-of-band `shellCommandRunning`. */
	shellCommandRunning: boolean;
	// ── Activity heuristic (agent-mode, non-hook-driven fallback) ──
	bytesSinceIdle: number;
	thresholdHitTimes: number[];
	lastInputAt: number;
	lastOutputChunkAt: number | null;
	/** Timestamp of the last bare ESC while Working — drives the double-press
	 *  cancel for agents that need two presses. Mirrors `escPressTimestamps`. */
	lastEscAt: number | null;
	// ── Subagent tracking (ADR-0022, docs/plans/subagent-aware-status.md) ──
	/** Live Subagents of this pane's Agent. `startedAt` drives the stale prune
	 *  (a lost stop event must not wedge the pane). Mirrored in the store's
	 *  out-of-band `subagentState` map. */
	activeSubagents: ReadonlyArray<{ id: string; startedAt: number }>;
	/** The main agent's turn-finished hook arrived while Subagents were alive —
	 *  the pane "owes a Ready" once the set drains (ADR-0022). */
	stopHeldForSubagents: boolean;
}

export interface StatusConfig {
	/** Bytes of agent output that constitute one heuristic "hit". Mirrors the
	 *  configurable `ACTIVITY_BYTE_THRESHOLD` (settings `activityByteThreshold`). */
	activityByteThreshold: number;
}

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
	activityByteThreshold: 1024,
};

// Timing constants — values preserved verbatim from the pre-refactor code
// (ptyActivityStore.ts / terminalManager.ts). Stage 2 makes these the single
// source those modules import.
export const IDLE_THRESHOLD_MS = 2000; // non-hook-driven idle scan
export const HOOK_IDLE_BACKSTOP_MS = 30000; // hook-driven backstop (dropped Stop)
export const INPUT_GATE_MS = 2000; // ignore output right after a keystroke
export const INACTIVITY_RESET_MS = 3000; // reset byte counter after an output gap
export const ESC_DOUBLE_PRESS_WINDOW_MS = 750; // double-ESC cancel window
// Wedge-breaker for a lost SubagentStop (the relay is fire-and-forget): prune
// on Tick, generous because Subagents legitimately run many minutes. Session
// end / PTY exit / ESC / the next prompt clear the set instantly (ADR-0022).
export const SUBAGENT_STALE_MS = 30 * 60_000;

export type StatusEvent =
	// Hook-driven transition (the translator resolved it via `mapHookEvent`).
	| { kind: "hook"; transition: StatusTransition; now: number }
	// An agent was detected in this PTY (title match or any hook). → agent mode.
	| { kind: "agentDetected" }
	// The agent session ended (hook "clear"). → shell mode.
	| { kind: "sessionEnded" }
	// Shell-integration `command_start` (or process-monitor `CommandStarted`).
	| { kind: "shellCommandStarted"; now: number }
	// Shell-integration `command_end` (or process-monitor `CommandFinished`,
	// `exit` undefined). Whichever source fired — they're mutually exclusive by
	// shell type.
	| { kind: "shellCommandEnded"; exit: number | null | undefined }
	// One agent-mode output chunk feeding the byte heuristic.
	| { kind: "output"; bytes: number; now: number }
	// A pre-classified keystroke. `escRequired` = presses to cancel for the
	// detected agent (1 for claude/gemini/qwen, else 2).
	| { kind: "keystroke"; key: KeystrokeKey; escRequired: number; now: number }
	// A Subagent started / stopped (subagent lifecycle hooks — these bypass
	// `mapHookEvent` because they carry an id, not a transition). ADR-0022.
	| { kind: "subagentStarted"; agentId: string; now: number }
	| { kind: "subagentStopped"; agentId: string; now: number }
	// The PTY process exited.
	| { kind: "ptyExited"; code: number | null }
	// The global idle scanner ticked.
	| { kind: "tick"; now: number }
	// Focus reassertion (workspace switch / projection) — acknowledge alerts.
	| { kind: "focus" }
	// A deliberate click/mousedown in the pane — acknowledge + dismiss Waiting.
	| { kind: "click" }
	// ── Atomic transitions (the old ptyActivityStore action methods, kept as
	// events so the store layer can drive the reducer 1:1 during migration). The
	// store's `markIdle` maps to the `focus` event above (same transition). ──
	| { kind: "recordOutput"; now: number }
	| { kind: "recordError" }
	| { kind: "recordExitSuccess" }
	| { kind: "clearError" }
	| { kind: "clearWaiting" }
	| { kind: "clearActive" };

export function initialStatusState(mode: StatusMode): StatusState {
	return {
		state: "idle",
		mode,
		hookDriven: false,
		workingSince: null,
		lastActivityAt: null,
		shellCommandRunning: false,
		bytesSinceIdle: 0,
		thresholdHitTimes: [],
		lastInputAt: 0,
		lastOutputChunkAt: null,
		lastEscAt: null,
		activeSubagents: NO_SUBAGENTS,
		stopHeldForSubagents: false,
	};
}

/** Shared empty set — keeps referential equality so `hydrate`/sync can use
 *  cheap identity checks on the common no-subagents path. */
export const NO_SUBAGENTS: ReadonlyArray<{ id: string; startedAt: number }> =
	[];

// ── Atomic transitions (mirror the old ptyActivityStore action methods) ──

/** `recordOutput`: idle/ready/error → Working and bump the activity markers. A
 *  Waiting agent and an already-Working PTY only refresh `lastActivityAt` — the
 *  dot is held (ADR-0015: a Waiting agent isn't cleared by its own output). */
function recordActivity(s: StatusState, now: number): StatusState {
	if (s.state === "waiting" && s.mode === "agent") {
		return { ...s, lastActivityAt: now };
	}
	if (s.state === "working") {
		return { ...s, lastActivityAt: now };
	}
	return { ...s, state: "working", workingSince: now, lastActivityAt: now };
}

/** `recordError`: → Error, preserving `hookDriven` (a shell/exit error, unlike a
 *  hook error, doesn't assert hook-drivenness). */
function recordError(s: StatusState): StatusState {
	return { ...s, state: "error" };
}

/** `recordExitSuccess`: agents take the Ready hop (notification); shells skip it
 *  straight to Idle (ADR-0009). */
function recordExitSuccess(s: StatusState): StatusState {
	return { ...s, state: s.mode === "agent" ? "ready" : "idle" };
}

/** `markIdle`: dismiss an acknowledged Ready/Error-shell alert. Never cancels an
 *  in-progress Working agent, a Waiting agent, or a running shell command. */
function markIdle(s: StatusState): StatusState {
	if (s.state === "idle" || s.state === "error") return s;
	if (s.state === "waiting" && s.mode === "agent") return s;
	if (s.state === "working" && s.mode === "agent") return s;
	if (s.state === "working" && s.shellCommandRunning) return s;
	return { ...s, state: "idle" };
}

function clearError(s: StatusState): StatusState {
	return s.state === "error" ? { ...s, state: "idle" } : s;
}

function clearWaiting(s: StatusState): StatusState {
	return s.state === "waiting" ? { ...s, state: "idle" } : s;
}

/** `clearActive`: the explicit ESC-cancel of an in-flight agent task. Only a
 *  Working agent is cancellable here — focus/click must not lie about progress.
 *  The user aborted, so the Subagent set is dropped too: a stale set must not
 *  hold the next turn's Stop or resurrect state on a late SubagentStop. */
function clearActive(s: StatusState): StatusState {
	return s.state === "working" && s.mode === "agent"
		? {
				...s,
				state: "idle",
				activeSubagents: NO_SUBAGENTS,
				stopHeldForSubagents: false,
			}
		: s;
}

/** `applyHookEvent`: hooks are authoritative, so `hookDriven` becomes true. Only
 *  the Working transition resets the activity-window markers.
 *
 *  Subagent interplay (ADR-0022): a "ready" (turn-finished) with live Subagents
 *  is HELD — the pane stays Working and owes a Ready once the set drains. A
 *  "working" (prompt submit) clears the hold but keeps the set (survivors must
 *  hold the next Stop too). An "error" clears the hold — an errored turn must
 *  not flip to Ready later when the set drains. */
function applyHook(
	s: StatusState,
	transition: StatusTransition,
	now: number,
): StatusState {
	if (transition === "working") {
		return {
			...s,
			state: "working",
			hookDriven: true,
			workingSince: now,
			lastActivityAt: now,
			stopHeldForSubagents: false,
		};
	}
	if (transition === "ready" && s.activeSubagents.length > 0) {
		return {
			...s,
			state: "working",
			hookDriven: true,
			stopHeldForSubagents: true,
		};
	}
	if (transition === "error") {
		return {
			...s,
			state: "error",
			hookDriven: true,
			stopHeldForSubagents: false,
		};
	}
	return { ...s, state: transition, hookDriven: true };
}

// ── Subagent lifecycle (ADR-0022, docs/plans/subagent-aware-status.md) ──

/** A Subagent started: add (or refresh — a duplicate id restarts its staleness
 *  clock) and make sure the pane reads busy. A Waiting or Error pane keeps its
 *  state — blocked-on-you / failed outrank "delegated work in progress". */
function subagentStarted(s: StatusState, id: string, now: number): StatusState {
	const others = s.activeSubagents.filter((a) => a.id !== id);
	const activeSubagents = [...others, { id, startedAt: now }];
	if (s.state === "working") {
		return { ...s, activeSubagents, hookDriven: true, lastActivityAt: now };
	}
	if (s.state === "waiting" || s.state === "error") {
		return { ...s, activeSubagents, hookDriven: true };
	}
	return {
		...s,
		activeSubagents,
		state: "working",
		hookDriven: true,
		workingSince: now,
		lastActivityAt: now,
	};
}

/** A Subagent stopped: drain it from the set (unknown id → no-op, covering
 *  mid-session provisioning and post-clear stragglers). The last stop releases
 *  a held turn-finished → Ready; it never mutates Waiting or Error. */
function subagentStopped(s: StatusState, id: string): StatusState {
	const kept = s.activeSubagents.filter((a) => a.id !== id);
	if (kept.length === s.activeSubagents.length) return s;
	const activeSubagents = kept.length === 0 ? NO_SUBAGENTS : kept;
	if (
		activeSubagents.length === 0 &&
		s.stopHeldForSubagents &&
		s.state === "working"
	) {
		return {
			...s,
			activeSubagents,
			stopHeldForSubagents: false,
			state: "ready",
		};
	}
	return { ...s, activeSubagents };
}

// ── Compound event handlers ──

function reduceOutput(
	s: StatusState,
	bytes: number,
	now: number,
	config: StatusConfig,
): StatusState {
	// The translator only emits `output` for agent-mode PTYs; defensive guard.
	if (s.mode !== "agent") return s;
	// Hook-driven: trust the hooks, just keep activity fresh so the backstop only
	// fires on a genuinely stuck agent (a dropped Stop). Mirrors `touchLastOutput`.
	if (s.hookDriven) return { ...s, lastActivityAt: now };
	// Input gate: ignore output for INPUT_GATE_MS after a keystroke so the echo
	// of the user's own typing doesn't read as agent activity.
	if (now - s.lastInputAt <= INPUT_GATE_MS) return s;

	let bytesSinceIdle = s.bytesSinceIdle;
	let thresholdHitTimes = s.thresholdHitTimes;
	// A long output gap resets the byte counter (filters slow trickle), but NOT
	// the hit history — agents pause for seconds between bursts while thinking.
	if (
		s.lastOutputChunkAt !== null &&
		now - s.lastOutputChunkAt > INACTIVITY_RESET_MS
	) {
		bytesSinceIdle = 0;
	}
	bytesSinceIdle += bytes;

	// Already Working: keep it fresh, don't re-fire.
	if (s.state === "working") {
		return {
			...s,
			bytesSinceIdle,
			thresholdHitTimes,
			lastOutputChunkAt: now,
			lastActivityAt: now,
		};
	}

	if (bytesSinceIdle >= config.activityByteThreshold) {
		bytesSinceIdle = 0;
		const result = recordThresholdHit(thresholdHitTimes, now);
		thresholdHitTimes = result.hitTimes;
		const base: StatusState = {
			...s,
			bytesSinceIdle,
			thresholdHitTimes,
			lastOutputChunkAt: now,
		};
		return result.fire ? recordActivity(base, now) : base;
	}
	return { ...s, bytesSinceIdle, thresholdHitTimes, lastOutputChunkAt: now };
}

function reduceKeystroke(
	s: StatusState,
	key: KeystrokeKey,
	escRequired: number,
	now: number,
): StatusState {
	// Every keystroke resets the input-gate clock and byte accumulator (the
	// terminalManager onData top-level effect).
	const base: StatusState = { ...s, lastInputAt: now, bytesSinceIdle: 0 };

	if (base.state === "waiting" && base.mode === "agent") {
		// A Waiting agent is answered/dismissed only by genuine input.
		if (key === "esc") return clearWaiting(base); // dismiss → Idle
		if (key === "answer") return applyHook(base, "working", now); // → Working
		return base; // any other key leaves it Waiting
	}

	if (base.state === "working" && base.mode === "agent") {
		// ESC is the user's cancel keystroke for an in-flight agent task.
		if (key === "esc") {
			const isFollowUp =
				base.lastEscAt !== null &&
				now - base.lastEscAt <= ESC_DOUBLE_PRESS_WINDOW_MS;
			if (escRequired === 1 || isFollowUp) {
				// clearActive — the abort also drops the Subagent set (ADR-0022).
				return {
					...base,
					state: "idle",
					lastEscAt: null,
					activeSubagents: NO_SUBAGENTS,
					stopHeldForSubagents: false,
				};
			}
			return { ...base, lastEscAt: now }; // arm the double-press
		}
		return { ...base, lastEscAt: null }; // any other key resets the tracker
	}

	// Otherwise a keystroke acknowledges: clear Error, dismiss Ready/idle-able.
	return markIdle(clearError(base));
}

function reduceTick(s: StatusState, now: number): StatusState {
	if (s.state !== "working") return s;
	if (s.shellCommandRunning) return s;
	// Live Subagents hold Working and SUPPRESS the idle backstop — background
	// Subagents produce no pane output, so quietness proves nothing (ADR-0022).
	// Only the stale prune (a lost SubagentStop) can shrink the set here.
	if (s.activeSubagents.length > 0) {
		const kept = s.activeSubagents.filter(
			(a) => now - a.startedAt <= SUBAGENT_STALE_MS,
		);
		if (kept.length === s.activeSubagents.length) return s;
		if (kept.length === 0 && s.stopHeldForSubagents) {
			return {
				...s,
				activeSubagents: NO_SUBAGENTS,
				stopHeldForSubagents: false,
				state: s.mode === "agent" ? "ready" : "idle",
			};
		}
		return {
			...s,
			activeSubagents: kept.length === 0 ? NO_SUBAGENTS : kept,
		};
	}
	const last = s.lastActivityAt ?? s.workingSince;
	if (last === null) return s;
	const threshold = s.hookDriven ? HOOK_IDLE_BACKSTOP_MS : IDLE_THRESHOLD_MS;
	if (now - last > threshold) {
		// Agent → Ready (finished, awaits acknowledgement); shell → Idle (no Ready
		// hop, ADR-0009).
		return { ...s, state: s.mode === "agent" ? "ready" : "idle" };
	}
	return s;
}

/** The pure status reducer. */
export function statusReducer(
	s: StatusState,
	e: StatusEvent,
	config: StatusConfig = DEFAULT_STATUS_CONFIG,
): StatusState {
	switch (e.kind) {
		case "hook":
			return applyHook(s, e.transition, e.now);
		case "agentDetected":
			return s.mode === "agent"
				? s
				: { ...s, mode: "agent", shellCommandRunning: false };
		case "sessionEnded":
			return s.mode === "shell"
				? s
				: {
						...s,
						mode: "shell",
						hookDriven: false,
						activeSubagents: NO_SUBAGENTS,
						stopHeldForSubagents: false,
					};
		case "shellCommandStarted":
			if (s.mode === "agent") return s;
			return recordActivity({ ...s, shellCommandRunning: true }, e.now);
		case "shellCommandEnded": {
			if (s.mode === "agent") return s;
			const next: StatusState = { ...s, shellCommandRunning: false };
			return classifyShellExit(e.exit) === "error"
				? recordError(next)
				: recordExitSuccess(next);
		}
		case "output":
			return reduceOutput(s, e.bytes, e.now, config);
		case "keystroke":
			return reduceKeystroke(s, e.key, e.escRequired, e.now);
		case "subagentStarted":
			return subagentStarted(s, e.agentId, e.now);
		case "subagentStopped":
			return subagentStopped(s, e.agentId);
		case "ptyExited": {
			// The process died — any Subagent bookkeeping died with it (ADR-0022).
			const cleared: StatusState = {
				...s,
				activeSubagents: NO_SUBAGENTS,
				stopHeldForSubagents: false,
			};
			return classifyShellExit(e.code) === "error"
				? recordError(cleared)
				: recordExitSuccess(cleared);
		}
		case "tick":
			return reduceTick(s, e.now);
		case "focus":
			return markIdle(s);
		case "click":
			return markIdle(clearError(clearWaiting(s)));
		case "recordOutput":
			return recordActivity(s, e.now);
		case "recordError":
			return recordError(s);
		case "recordExitSuccess":
			return recordExitSuccess(s);
		case "clearError":
			return clearError(s);
		case "clearWaiting":
			return clearWaiting(s);
		case "clearActive":
			return clearActive(s);
	}
}

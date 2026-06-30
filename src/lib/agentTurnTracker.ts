// Agent Turn tracker.
//
// Records one row per Turn (a single prompt → turn-finished cycle) for the
// Statistics overlay. See docs/plans/agent-turn-telemetry-and-statistics-overlay.md
// and ADR-0018.
//
// Design: the ptyActivityStore subscription is the primary driver — it observes
// every PtyActivityState transition, which is the SUPERSET of signals we need:
// hook-driven transitions (applyHookEvent), the idle-scanner backstop (a stuck
// "active" → "ready"), and error/ready alike. So begin / timing / finalize-on-
// ready-or-error all hang off it. The hook listener in terminalManager.ts adds
// the two things the activity state can't express: tool-call counts (the
// toolName lives in the raw hook payload) and SessionEnd (which exits agent
// mode without changing the dot state). The PTY exit handlers add pty-exit
// fidelity. All of those funnel into the same idempotent engine here.
//
// Attribution is a per-Turn working-tree diff (ADR-0021): snapshot the
// workspace's working tree to a git tree at Turn start and finalize, then diff
// the two — the additions/deletions between them are the lines the Turn
// changed. (This replaced a net-vs-base-branch delta that recorded +0 −0 for
// most edit Turns.) Line counts are NULL ("unmeasured") when two Turns overlap
// in one Workspace (the shared working tree can't be split between them), when
// the Workspace isn't a git repo, or when a snapshot is unavailable.

import { useProfileStore } from "../stores/profileStore";
import {
	subscribeStatusChange,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { type AgentTurnRecord, git, telemetry } from "./ipc";
import { findPaneLocation } from "./notificationRouter";
import type { PtyActivityState } from "./types";

interface OpenTurn {
	id: string;
	sessionId: string | null;
	ptyId: string;
	agentId: string;
	profileId: string;
	workspaceId: string | null;
	workspacePath: string;
	workspaceName: string;
	/** Repo root for the start/finalize worktree snapshots (ADR-0021). */
	cwd: string | null;
	/** Base branch — retained context (no longer used for line counts). */
	baseBranch: string | null;
	startedAt: number;
	workingMs: number;
	waitingMs: number;
	/** Timestamp the current Working / Waiting stretch began, or null. */
	workingSince: number | null;
	waitingSince: number | null;
	lastState: PtyActivityState;
	permissionRequests: number;
	errors: number;
	/** Worktree tree OID captured at Turn begin (resolves async via
	 *  startTreePromise). Null until it resolves, or permanently null if the
	 *  begin snapshot failed / the Workspace isn't a git repo. */
	startTreeOid: string | null;
	/** In-flight begin snapshot, awaited at finalize so a fast Turn that ends
	 *  before it resolves still gets attribution. Never rejects (catches to null). */
	startTreePromise: Promise<string | null> | null;
	/** Set when another Turn was open in the same Workspace at any point during
	 *  this Turn's life — line counts become NULL (unattributed). */
	contaminated: boolean;
}

const openTurns = new Map<string, OpenTurn>();
// Session id per PTY, minted on first Turn and reused across Turns until the
// session ends (SessionEnd / pty exit). Lets the overlay group a session's
// Turns and answer "how long was the agent running".
const sessionByPty = new Map<string, string>();

function nowMs(): number {
	return Date.now();
}

function randomId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}
}

function ensureSession(ptyId: string): string {
	let s = sessionByPty.get(ptyId);
	if (!s) {
		s = randomId();
		sessionByPty.set(ptyId, s);
	}
	return s;
}

/** Reverse panePtyMap (ptyId → paneId), then resolve the owning Workspace and
 *  its Profile. Returns null when the PTY isn't a detected Agent. */
function resolveContext(ptyId: string): {
	agentId: string;
	profileId: string;
	workspaceId: string | null;
	workspacePath: string;
	workspaceName: string;
	cwd: string | null;
	baseBranch: string | null;
} | null {
	const act = usePtyActivityStore.getState();
	const agentId = act.detectedAgentIds[ptyId];
	if (!agentId) return null;

	let paneId: string | undefined;
	for (const [pid, pty] of Object.entries(act.panePtyMap)) {
		if (pty === ptyId) {
			paneId = pid;
			break;
		}
	}
	const loc = paneId ? findPaneLocation(paneId) : null;
	const ws = loc
		? useWorkspaceStore
				.getState()
				.workspaces.find((w) => w.id === loc.workspaceId)
		: undefined;
	// A Turn's Profile is its Workspace's Profile; fall back to the Window's
	// Active profile when the Workspace can't be resolved (it should always
	// match, since only the Active profile's Workspaces are Opened).
	const profileId = ws?.profileId ?? useProfileStore.getState().activeProfileId;
	if (!profileId) return null;

	return {
		agentId,
		profileId,
		workspaceId: ws?.id ?? null,
		workspacePath: ws?.rootFolder ?? "",
		workspaceName: ws?.name ?? "",
		cwd: ws?.rootFolder ?? act.cwds[ptyId] ?? null,
		baseBranch: ws?.baseBranch ?? null,
	};
}

/** Accrue the open Working / Waiting stretch into the totals. */
function flushTimers(t: OpenTurn, now: number): void {
	if (t.workingSince !== null) {
		t.workingMs += now - t.workingSince;
		t.workingSince = null;
	}
	if (t.waitingSince !== null) {
		t.waitingMs += now - t.waitingSince;
		t.waitingSince = null;
	}
}

/** Move an open Turn's timers to a new state. Idempotent on repeated state. */
function transitionTimers(
	t: OpenTurn,
	newState: PtyActivityState,
	now: number,
) {
	if (t.lastState === newState) return;
	flushTimers(t, now);
	if (newState === "active") {
		t.workingSince = now;
	} else if (newState === "waiting") {
		t.waitingSince = now;
		// Counts entries into Waiting (surfaced as "Blocked on you"). Usually a
		// permission prompt, but the activity-store signal can't prove that, so
		// this is an approximate "times the turn paused on you", not a strict
		// permission-request count.
		t.permissionRequests += 1;
	}
	t.lastState = newState;
}

/**
 * Primary engine, called by the ptyActivityStore subscription on every state
 * change for an agent-mode PTY (and by tests).
 *  - "active" with no open Turn → begin a Turn.
 *  - "active" while open → resume the Working timer.
 *  - "ready" → finalize (stop). "error" → finalize (error).
 *  - "waiting"/"idle" → update timers, keep the Turn open (idle mid-Turn, e.g.
 *    answering a permission prompt, is transient — only ready/error/session-end/
 *    pty-exit/the backstop end a Turn).
 */
export function noteState(
	ptyId: string,
	state: PtyActivityState,
): Promise<void> | void {
	const now = nowMs();
	const open = openTurns.get(ptyId);

	if (state === "active") {
		if (open) {
			transitionTimers(open, "active", now);
			return;
		}
		const ctx = resolveContext(ptyId);
		if (!ctx) return;
		const turn: OpenTurn = {
			id: randomId(),
			sessionId: ensureSession(ptyId),
			ptyId,
			agentId: ctx.agentId,
			profileId: ctx.profileId,
			workspaceId: ctx.workspaceId,
			workspacePath: ctx.workspacePath,
			workspaceName: ctx.workspaceName,
			cwd: ctx.cwd,
			baseBranch: ctx.baseBranch,
			startedAt: now,
			workingMs: 0,
			waitingMs: 0,
			workingSince: now,
			waitingSince: null,
			lastState: "active",
			permissionRequests: 0,
			errors: 0,
			startTreeOid: null,
			startTreePromise: null,
			contaminated: false,
		};
		// Capture the start-of-Turn worktree snapshot, fire-and-forget so the
		// begin path stays non-blocking. There's a small documented race: edits
		// landing before this resolves leak into the baseline (ADR-0021). The
		// turn-start hook fires before the agent edits, and the scan is fast, so
		// it's rare and fails safe (under-counts, never crashes).
		if (turn.cwd) {
			turn.startTreePromise = git
				.snapshotWorktree(turn.cwd)
				.then((oid) => (turn.startTreeOid = oid))
				.catch(() => null);
		}
		// Overlap: mark this Turn and every other open Turn in the same Workspace
		// as contaminated, so all of them null-out their line attribution.
		if (turn.workspaceId !== null) {
			for (const other of openTurns.values()) {
				if (other.workspaceId === turn.workspaceId) {
					other.contaminated = true;
					turn.contaminated = true;
				}
			}
		}
		openTurns.set(ptyId, turn);
		return;
	}

	if (!open) return;

	if (state === "ready") return finalize(ptyId, "stop", now);
	if (state === "error") {
		open.errors += 1;
		return finalize(ptyId, "error", now);
	}
	// "waiting" or "idle": pause/resume timers, keep the Turn open.
	transitionTimers(open, state, now);
}

/** SessionEnd ("clear") — finalize an open Turn and end the session so the next
 *  Agent launch in this PTY starts a fresh session. */
export function onSessionEnd(ptyId: string): Promise<void> | void {
	const p = finalize(ptyId, "session_end", nowMs());
	sessionByPty.delete(ptyId);
	return p;
}

/** PTY exit — finalize an open Turn with pty-exit fidelity and end the session.
 *  Call this BEFORE recordExitSuccess/recordError so the reason is pty_exit
 *  rather than a subsequent ready/error from the activity store. */
export function onPtyExit(ptyId: string): Promise<void> | void {
	const p = finalize(ptyId, "pty_exit", nowMs());
	sessionByPty.delete(ptyId);
	return p;
}

/** Finalize every open Turn (used on app quit). Awaitable so the quit path can
 *  best-effort flush before windows tear down. */
export function finalizeAllOpenTurns(
	reason: AgentTurnRecord["endReason"],
): Promise<void> {
	const now = nowMs();
	const ps: Array<Promise<void> | void> = [];
	for (const ptyId of [...openTurns.keys()]) {
		ps.push(finalize(ptyId, reason ?? "app_quit", now));
	}
	return Promise.all(ps).then(() => undefined);
}

/** Pop the open Turn (synchronously, so a concurrent transition can't double-
 *  finalize and so the overlap check sees the correct remaining set), flush its
 *  timers, then asynchronously snapshot git and persist. */
function finalize(
	ptyId: string,
	reason: NonNullable<AgentTurnRecord["endReason"]>,
	now: number,
): Promise<void> | void {
	const t = openTurns.get(ptyId);
	if (!t) return;
	openTurns.delete(ptyId);
	flushTimers(t, now);
	return writeRecord(t, reason, now);
}

async function writeRecord(
	t: OpenTurn,
	reason: NonNullable<AgentTurnRecord["endReason"]>,
	endedAt: number,
): Promise<void> {
	// Per-Turn working-tree diff (ADR-0021): snapshot the worktree now and diff
	// against the start snapshot — the result is the lines this Turn changed.
	// Stays NULL ("unmeasured") when the Turn overlapped another in the same
	// Workspace, the Workspace isn't a git repo, or a snapshot was unavailable.
	let linesAdded: number | null = null;
	let linesDeleted: number | null = null;
	let filesChanged: number | null = null;
	if (!t.contaminated && t.cwd) {
		// Await the fire-and-forget begin snapshot so a fast Turn that finalizes
		// before it resolves still gets attribution.
		const startOid = await (t.startTreePromise ??
			Promise.resolve(t.startTreeOid));
		if (startOid) {
			try {
				const endOid = await git.snapshotWorktree(t.cwd);
				if (endOid) {
					const s = await git.diffTrees(t.cwd, startOid, endOid);
					// Tree-diff sides are independently non-negative — no flooring.
					linesAdded = s.additions;
					linesDeleted = s.deletions;
					filesChanged = s.files;
				}
			} catch {
				// Leave NULL ("unmeasured") on any snapshot/diff failure.
			}
		}
	}

	const record: AgentTurnRecord = {
		id: t.id,
		sessionId: t.sessionId,
		profileId: t.profileId,
		workspaceId: t.workspaceId,
		workspacePath: t.workspacePath,
		workspaceName: t.workspaceName,
		agentId: t.agentId,
		ptyId: t.ptyId,
		startedAt: t.startedAt,
		endedAt,
		durationMs: endedAt - t.startedAt,
		workingMs: t.workingMs,
		waitingMs: t.waitingMs,
		endReason: reason,
		permissionRequestsCount: t.permissionRequests,
		errorCount: t.errors,
		linesAdded,
		linesDeleted,
		filesChanged,
		// The vs-base provenance columns were retired with the net-vs-base
		// metric (ADR-0021); kept in the schema, written NULL.
		gitAddedStart: null,
		gitDeletedStart: null,
		gitAddedEnd: null,
		gitDeletedEnd: null,
		createdAt: 0, // set by the DB default
	};

	try {
		await telemetry.recordTurn(record);
	} catch {
		// Telemetry is best-effort; never disrupt the session on a write error.
	}
}

let subscribed = false;
const unsubscribers: Array<() => void> = [];

/** Wire the tracker to the Status transition stream. Call once at the App root. */
export function initAgentTurnTracker(): void {
	if (subscribed) return;
	subscribed = true;

	// Primary driver: the Status transition output seam. Each StatusChange names
	// the one PTY that moved and carries its `cause`, so end-reason fidelity
	// arrives in-band — no inline trackPtyExit, and no ordering race against the
	// activity-state flip. See docs/plans/status-machine.md.
	unsubscribers.push(
		subscribeStatusChange(({ ptyId, prev, next, cause }) => {
			const isAgent =
				next.detectionMode === "agent" ||
				prev.detectionMode === "agent" ||
				openTurns.has(ptyId);
			if (!isAgent) return;

			// `recordExitSuccess` / `recordError` on an **agent-mode** PTY is a real pty
			// exit — the onStatus "exited" path leaves the PTY in agent mode — so the
			// cause IS the pty-exit signal: finalize as pty_exit, ahead of (and instead
			// of) the ready/error state's would-be stop/error finalize. The same causes
			// also fire on a shell `command_end`/`commandFinished`; there the PTY is in
			// shell mode, so the detectionMode gate routes it to noteState below —
			// keeping a lingering Turn open (as on `main`) rather than finalizing it as a
			// pty_exit. Session-end stays an explicit trackSessionEnd in terminalManager's
			// hook-clear path (the same clearAgentPty also fires on a shell command_end
			// that merely drops agent mode, which must NOT finalize a Turn).
			if (
				next.detectionMode === "agent" &&
				(cause.kind === "recordExitSuccess" || cause.kind === "recordError")
			) {
				void onPtyExit(ptyId);
				return;
			}
			// Mode-only changes (agentDetected / sessionEnded flip detectionMode while
			// leaving `state` untouched) emit a StatusChange but are NOT state
			// transitions; skip unchanged-state entries — otherwise detecting an agent
			// mid-activity would start a Turn at detection time, and a session-end
			// mid-turn could resume or finalize one.
			//
			// Exception: a turn-start hook (`userPromptSubmitted`/`UserPromptSubmit`/…
			// → "working") IS a turn boundary even when the dot is already Working. A
			// command-detected Agent whose TUI floods output (e.g. Copilot) trips the
			// activity byte-heuristic into Working *before* its first hook; that first
			// hook then only flips `hookDriven` (Working→Working), and dropping it here
			// would never open the Turn. So always let a hook "working" cause through.
			const startsWork =
				cause.kind === "hook" && cause.transition === "working";
			if (prev.state === next.state && !startsWork) return;
			void noteState(ptyId, next.state);
		}),
	);

	// Backstop: a PTY removed from the store (teardown without a pty-exit event)
	// with a Turn still open → finalize as a pty exit. A removal isn't a status
	// transition, so it can't ride the StatusChange seam.
	unsubscribers.push(
		usePtyActivityStore.subscribe((state, prev) => {
			for (const ptyId of [...openTurns.keys()]) {
				if (!state.activities[ptyId] && prev.activities[ptyId]) {
					void onPtyExit(ptyId);
				}
			}
		}),
	);
}

/** Test-only: clear all in-memory state between cases. */
export function __resetAgentTurnTrackerForTests(): void {
	openTurns.clear();
	sessionByPty.clear();
	for (const unsub of unsubscribers.splice(0)) unsub();
	subscribed = false;
}

/** Test-only: inspect open Turn count. */
export function __openTurnCountForTests(): number {
	return openTurns.size;
}

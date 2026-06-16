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
// Attribution is git-diff delta: snapshot the workspace's cached additions/
// deletions at Turn start, fetch fresh totals at finalize, store the
// difference. Line counts are NULL ("unattributed") when two Turns overlap in
// one Workspace — the per-Workspace git delta can't be split between them.

import { useProfileStore } from "../stores/profileStore";
import {
	type PtyActivityEntry,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { type AgentTurnRecord, git, telemetry } from "./ipc";
import { findPaneLocation } from "./notificationRouter";
import type { PtyActivityState } from "./types";

interface GitSnapshot {
	added: number;
	deleted: number;
	files: number;
}

interface OpenTurn {
	id: string;
	sessionId: string | null;
	ptyId: string;
	agentId: string;
	profileId: string;
	workspaceId: string | null;
	workspacePath: string;
	workspaceName: string;
	/** Repo root + base branch for the finalize-time fetchBundle. */
	cwd: string | null;
	baseBranch: string | null;
	startedAt: number;
	workingMs: number;
	waitingMs: number;
	/** Timestamp the current Working / Waiting stretch began, or null. */
	workingSince: number | null;
	waitingSince: number | null;
	lastState: PtyActivityState;
	permissionRequests: number;
	toolCalls: number;
	errors: number;
	gitStart: GitSnapshot | null;
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

function cachedGitSnapshot(workspaceId: string | null): GitSnapshot | null {
	if (!workspaceId) return null;
	const info = useWorkspaceGitStore.getState().byWorkspaceId[workspaceId];
	if (!info) return null;
	return {
		added: info.additions,
		deleted: info.deletions,
		files: info.changedFileCount,
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
		t.permissionRequests += 1; // counts entries into Waiting
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
			toolCalls: 0,
			errors: 0,
			gitStart: cachedGitSnapshot(ctx.workspaceId),
			contaminated: false,
		};
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

/** Increment the open Turn's tool-call count (called from the hook listener
 *  when a hook payload carries a toolName). No-op if no Turn is open. */
export function recordToolCall(ptyId: string): void {
	const t = openTurns.get(ptyId);
	if (t) t.toolCalls += 1;
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

function sumBundleFiles(
	changedFiles: { additions: number; deletions: number }[],
): GitSnapshot {
	let added = 0;
	let deleted = 0;
	for (const f of changedFiles) {
		added += f.additions;
		deleted += f.deletions;
	}
	return { added, deleted, files: changedFiles.length };
}

async function writeRecord(
	t: OpenTurn,
	reason: NonNullable<AgentTurnRecord["endReason"]>,
	endedAt: number,
): Promise<void> {
	// Prefer a fresh git read at finalize (the scheduler push may be coalesced
	// and stale); fall back to the cached snapshot if the fetch fails.
	let gitEnd: GitSnapshot | null = null;
	if (t.cwd) {
		try {
			const bundle = await git.fetchBundle(t.cwd, t.baseBranch);
			gitEnd = sumBundleFiles(bundle.changedFiles);
		} catch {
			gitEnd = cachedGitSnapshot(t.workspaceId);
		}
	} else {
		gitEnd = cachedGitSnapshot(t.workspaceId);
	}

	let linesAdded: number | null = null;
	let linesDeleted: number | null = null;
	let filesChanged: number | null = null;
	if (!t.contaminated && t.gitStart && gitEnd) {
		linesAdded = Math.max(0, gitEnd.added - t.gitStart.added);
		linesDeleted = Math.max(0, gitEnd.deleted - t.gitStart.deleted);
		filesChanged = Math.max(0, gitEnd.files - t.gitStart.files);
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
		toolCallsCount: t.toolCalls,
		errorCount: t.errors,
		linesAdded,
		linesDeleted,
		filesChanged,
		gitAddedStart: t.gitStart?.added ?? null,
		gitDeletedStart: t.gitStart?.deleted ?? null,
		gitAddedEnd: gitEnd?.added ?? null,
		gitDeletedEnd: gitEnd?.deleted ?? null,
		createdAt: 0, // set by the DB default
	};

	try {
		await telemetry.recordTurn(record);
	} catch {
		// Telemetry is best-effort; never disrupt the session on a write error.
	}
}

let subscribed = false;

/** Wire the tracker to the activity store. Call once at the App root. */
export function initAgentTurnTracker(): void {
	if (subscribed) return;
	subscribed = true;
	usePtyActivityStore.subscribe((state, prev) => {
		// State transitions for agent-mode PTYs (and any PTY with an open Turn).
		for (const [ptyId, entry] of Object.entries(state.activities)) {
			const prevEntry = prev.activities[ptyId] as PtyActivityEntry | undefined;
			if (!prevEntry || prevEntry.state === entry.state) continue;
			const isAgent =
				entry.detectionMode === "agent" || state.agentPtyIds.has(ptyId);
			if (!isAgent && !openTurns.has(ptyId)) continue;
			void noteState(ptyId, entry.state);
		}
		// A PTY removed from the store (removePty) with a Turn still open →
		// finalize as a pty exit (the explicit onPtyExit usually beats this).
		for (const ptyId of [...openTurns.keys()]) {
			if (!state.activities[ptyId] && prev.activities[ptyId]) {
				void onPtyExit(ptyId);
			}
		}
	});
}

/** Test-only: clear all in-memory state between cases. */
export function __resetAgentTurnTrackerForTests(): void {
	openTurns.clear();
	sessionByPty.clear();
	subscribed = false;
}

/** Test-only: inspect open Turn count. */
export function __openTurnCountForTests(): number {
	return openTurns.size;
}

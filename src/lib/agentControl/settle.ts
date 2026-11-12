// When an `agent wait` (or `agent prompt --wait`) is over. Pure, so the rules
// test as sequences of statuses; `waitForPane` feeds it the live ones.

import type { PtyActivityState, PtyDetectionMode } from "../types";
import type { Until } from "./types";

/** How long a prompted Agent has to start Working before the wait gives up
 *  with `stalled`: the prompt probably never reached it. */
export const STALL_MS = 5000;

export interface WaitGoal {
	until: Until;
	/** After a prompt: the state the Agent is in when the prompt goes out
	 *  (Ready from its last turn, say) is not an answer. Only a state reached
	 *  after it was seen **Working** counts. */
	needWorking: boolean;
}

export interface PaneSnapshot {
	state: PtyActivityState | null;
	mode: PtyDetectionMode | null;
	/** The PTY has exited, or the pane has closed. */
	gone: boolean;
}

/** How a wait ended. `left`: the Agent quit (or the pane closed) first. */
export type WaitEnd = "ready" | "waiting" | "error" | "left";

export interface WaitProgress {
	sawWorking: boolean;
	end: WaitEnd | null;
}

function matches(until: Until, state: PtyActivityState | null): boolean {
	if (until === "settled") {
		return state === "ready" || state === "waiting" || state === "error";
	}
	return state === until;
}

/** Feed one snapshot to a wait. Call it with the snapshot at the start too. */
export function waitStep(
	goal: WaitGoal,
	progress: WaitProgress,
	snap: PaneSnapshot,
): WaitProgress {
	if (progress.end) return progress;
	if (snap.gone || snap.mode !== "agent") {
		return { sawWorking: progress.sawWorking, end: "left" };
	}
	const sawWorking = progress.sawWorking || snap.state === "active";
	if (goal.needWorking && !sawWorking) return { sawWorking, end: null };
	if (matches(goal.until, snap.state)) {
		return { sawWorking, end: snap.state as WaitEnd };
	}
	return { sawWorking, end: null };
}

/** Whether a prompted wait has stalled: no Working within `STALL_MS`. */
export function isStalled(
	goal: WaitGoal,
	progress: WaitProgress,
	elapsedMs: number,
): boolean {
	return (
		goal.needWorking &&
		!progress.sawWorking &&
		progress.end === null &&
		elapsedMs >= STALL_MS
	);
}

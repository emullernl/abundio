// The live half of `agent wait`: watch one pane's status until `settle.ts`
// says the wait is over. Rust owns the overall timeout; when it gives up it
// cancels the request, which aborts `signal` here.

import {
	subscribeStatusChange,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { getTerminal } from "../terminalManager";
import {
	isStalled,
	type PaneSnapshot,
	type WaitEnd,
	type WaitGoal,
	type WaitProgress,
	waitStep,
} from "./settle";
import { ControlError } from "./types";

/** Status changes are pushed, but a re-check this often also catches a pane
 *  that closed and the stall deadline. */
const POLL_MS = 250;

function snapshot(paneId: string, fallbackPtyId: string): PaneSnapshot {
	const ptyId =
		getTerminal(paneId)?.ptyId ||
		usePtyActivityStore.getState().panePtyMap[paneId] ||
		fallbackPtyId;
	const ws = useWorkspaceStore.getState();
	const open = ws.findWorkspaceForPane(paneId) !== null;
	const entry = usePtyActivityStore.getState().activities[ptyId];
	return {
		state: entry?.state ?? null,
		mode: entry?.detectionMode ?? null,
		gone: !open || !ptyId || ws.ptyStatuses[ptyId]?.type === "exited",
	};
}

export interface WaitOutcome {
	end: WaitEnd;
	waitedMs: number;
}

/**
 * Resolve when the pane reaches the goal, reject with `stalled` when a
 * prompted Agent never starts Working. Starts watching synchronously, so a
 * prompt sent right after the call cannot slip past it.
 */
export function waitForPane(
	paneId: string,
	ptyId: string,
	goal: WaitGoal,
	signal: AbortSignal,
): Promise<WaitOutcome> {
	const started = Date.now();
	let progress: WaitProgress = { sawWorking: false, end: null };

	const promise = new Promise<WaitOutcome>((resolve, reject) => {
		const check = () => {
			progress = waitStep(goal, progress, snapshot(paneId, ptyId));
			const waitedMs = Date.now() - started;
			if (progress.end) {
				done();
				resolve({ end: progress.end, waitedMs });
			} else if (isStalled(goal, progress, waitedMs)) {
				done();
				reject(
					new ControlError(
						"stalled",
						"the prompt was sent, but the Agent did not start working within 5 seconds; read the pane to see what happened before sending it again",
					),
				);
			}
		};
		const unsubscribe = subscribeStatusChange((c) => {
			if (c.ptyId === snapshotPty()) check();
		});
		const timer = setInterval(check, POLL_MS);
		const onAbort = () => {
			done();
			reject(new Error("cancelled"));
		};
		const done = () => {
			unsubscribe();
			clearInterval(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const snapshotPty = () =>
			getTerminal(paneId)?.ptyId ||
			usePtyActivityStore.getState().panePtyMap[paneId] ||
			ptyId;
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort);
		// A prompted wait's first look only records the state it starts from
		// (the prompt has not gone out yet); a plain wait may end right here.
		check();
	});
	return promise;
}

/**
 * What the **Orchestrator view**'s graph animates (ADR-0057): Agent control
 * calls from one pane at another, for as long as each runs. In memory, this
 * Window only (Agent control is carried out by the Window that owns the
 * target's Workspace, and a Profile lives in one Window, so every call of the
 * Profile passes here).
 */

import type { ControlRequest } from "./agentControl/types";
import { currentWindowLabel } from "./appWindow";

export interface ControlActivity {
	/** Unique per call. */
	id: number;
	callerPaneId: string;
	targetPaneId: string;
	/** `read` only looks; `act` changes something (prompt, keys, close…). */
	kind: "read" | "act";
	startedAt: number;
}

export type ControlActivityEvent =
	| { type: "start"; call: ControlActivity }
	| { type: "end"; id: number }
	/** A call aimed at no pane (`file open`): the caller's node pulses. */
	| { type: "pulse"; paneId: string };

/** The Window's own read: Rust answers the others and says their kind. */
const READ_OPS = new Set<ControlRequest["op"]>(["pane.watch"]);

/** Whether a call with `op` only looks at its target. */
export function controlKind(op: ControlRequest["op"]): "read" | "act" {
	return READ_OPS.has(op) ? "read" : "act";
}

type Listener = (e: ControlActivityEvent) => void;
const listeners = new Set<Listener>();
const running = new Map<number, ControlActivity>();
let nextId = 1;

function emit(e: ControlActivityEvent): void {
	for (const l of listeners) l(e);
}

/**
 * A call has started. Returns the function that ends it, which is safe to
 * call more than once. A call a pane makes at itself is not drawn.
 */
export function startControlActivity(
	given: Omit<ControlActivity, "id" | "startedAt">,
): () => void {
	const a = { ...given, callerPaneId: localCaller(given.callerPaneId) };
	if (a.callerPaneId === a.targetPaneId) return () => {};
	const call: ControlActivity = { ...a, id: nextId++, startedAt: Date.now() };
	running.set(call.id, call);
	emit({ type: "start", call });
	return () => {
		if (!running.delete(call.id)) return;
		emit({ type: "end", id: call.id });
	};
}

/** A call that touched no other pane: its caller's node pulses once. */
export function pulseControlActivity(paneId: string): void {
	emit({ type: "pulse", paneId: localCaller(paneId) });
}

/** A call a Host ran for one of this Window's own Agents names it
 *  `outside:<this Window>:<pane>` (ADR-0065): its line starts at that pane. */
export function localCaller(
	callerPaneId: string,
	windowLabel: string = currentWindowLabel(),
): string {
	const prefix = `outside:${windowLabel}:`;
	return callerPaneId.startsWith(prefix)
		? callerPaneId.slice(prefix.length)
		: callerPaneId;
}

/** The calls running now, for a graph that mounts in the middle of them. */
export function runningControlActivity(): ControlActivity[] {
	return [...running.values()];
}

export function subscribeControlActivity(l: Listener): () => void {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

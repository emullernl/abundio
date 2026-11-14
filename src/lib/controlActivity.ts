/**
 * What the **Orchestrator view**'s graph animates (ADR-0057): Agent control
 * calls from one pane at another, for as long as each runs. In memory, this
 * Window only (Agent control is carried out by the Window that owns the
 * target's Workspace, and a Profile lives in one Window, so every call of the
 * Profile passes here).
 */

import type { ControlRequest } from "./agentControl/types";

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
	| { type: "end"; id: number };

const READ_OPS = new Set<ControlRequest["op"]>([
	"resolve",
	"pane.read",
	"pane.watch",
	"agent.wait",
]);

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
	a: Omit<ControlActivity, "id" | "startedAt">,
): () => void {
	if (a.callerPaneId === a.targetPaneId) return () => {};
	const call: ControlActivity = { ...a, id: nextId++, startedAt: Date.now() };
	running.set(call.id, call);
	emit({ type: "start", call });
	return () => {
		if (!running.delete(call.id)) return;
		emit({ type: "end", id: call.id });
	};
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

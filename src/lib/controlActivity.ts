/**
 * What the **Orchestrator view**'s graph animates (ADR-0057): one Agent
 * control call from one pane at another. In memory, this Window only (Agent
 * control is carried out by the Window that owns the target's Workspace,
 * and a Profile lives in one Window, so every call of the Profile passes
 * here).
 */

import type { ControlRequest } from "./agentControl/types";

export interface ControlActivity {
	callerPaneId: string;
	targetPaneId: string;
	/** `read` only looks; `act` changes something (prompt, keys, close…). */
	kind: "read" | "act";
	at: number;
}

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

type Listener = (a: ControlActivity) => void;
const listeners = new Set<Listener>();

export function publishControlActivity(a: Omit<ControlActivity, "at">): void {
	if (a.callerPaneId === a.targetPaneId) return;
	const event = { ...a, at: Date.now() };
	for (const l of listeners) l(event);
}

export function subscribeControlActivity(l: Listener): () => void {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

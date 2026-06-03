// Per-tool debounce for Copilot's "waiting" status.
//
// Copilot fires hooks per tool in the order `preToolUse → permissionRequest →
// postToolUse` (confirmed from captured event logs — this contradicts GitHub's
// published docs). `permissionRequest` fires only for permission-gated tools
// (edits/writes; read-kind tools short-circuit it) and fires EVEN on autopilot,
// where the gate is auto-approved and `postToolUse` follows ~100 ms later. The
// only "this tool finished / is unblocked" signal is `postToolUse`, which
// arrives after the tool runs.
//
// Mapping `permissionRequest → "waiting"` directly therefore flickered the
// sky-blue Waiting dot (and fired a notification) for every permission-gated
// tool. Instead, a `permissionRequest` here starts a 1500 ms timer; a matching
// `postToolUse`/`postToolUseFailure` cancels it. If the timer elapses with no
// `postToolUse` AND the pane has gone quiet (no output for the window — a
// still-running tool keeps streaming), the tool is treated as a genuine block:
// the pane enters "waiting" via the normal store transition (which the existing
// notification subscriber + blur/visibility gate then handle).
//
// Copilot-only. Other Agents enter "waiting" immediately on a permission/input
// hook (theirs fire only on a genuine prompt). `exit_plan_mode`/`ask_user` are
// not routed here — Copilot fires only `preToolUse` for them, handled as an
// immediate "waiting" by agentHookMap. See ADR-0015.

import {
	getLastOutputAt,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";

export const WAITING_DEBOUNCE_MS = 1500;

// A single outstanding permission gate for a tool call. `confirmed` flips true
// once its timer has elapsed and the pane entered "waiting".
interface PendingGate {
	timer: ReturnType<typeof setTimeout> | undefined;
	confirmed: boolean;
}

// ptyId → toolName → FIFO queue of outstanding gates. FIFO because the payload
// carries no tool-call id: parallel calls to the same tool are matched
// oldest-first (a rare, tolerable imprecision).
const pending = new Map<string, Map<string, PendingGate[]>>();

function queueFor(ptyId: string, toolName: string): PendingGate[] {
	let byTool = pending.get(ptyId);
	if (!byTool) {
		byTool = new Map();
		pending.set(ptyId, byTool);
	}
	let queue = byTool.get(toolName);
	if (!queue) {
		queue = [];
		byTool.set(toolName, queue);
	}
	return queue;
}

function anyConfirmed(ptyId: string): boolean {
	const byTool = pending.get(ptyId);
	if (!byTool) return false;
	for (const queue of byTool.values()) {
		for (const gate of queue) {
			if (gate.confirmed) return true;
		}
	}
	return false;
}

// Drop the oldest gate for a tool and tidy up empty maps.
function shiftGate(ptyId: string, toolName: string): PendingGate | undefined {
	const byTool = pending.get(ptyId);
	const queue = byTool?.get(toolName);
	const gate = queue?.shift();
	if (byTool && queue && queue.length === 0) {
		byTool.delete(toolName);
		if (byTool.size === 0) pending.delete(ptyId);
	}
	return gate;
}

function scheduleCheck(ptyId: string, gate: PendingGate): void {
	gate.timer = setTimeout(() => {
		const lastOutput = getLastOutputAt(ptyId);
		const quietFor = lastOutput === null ? Infinity : Date.now() - lastOutput;
		if (quietFor < WAITING_DEBOUNCE_MS) {
			// Output is still flowing → the tool is running, not blocked. Re-arm
			// and re-check once the pane has had a chance to go quiet.
			scheduleCheck(ptyId, gate);
			return;
		}
		// No postToolUse and the pane is quiet → a genuine permission block.
		gate.confirmed = true;
		usePtyActivityStore.getState().applyHookEvent(ptyId, "waiting");
	}, WAITING_DEBOUNCE_MS);
}

/**
 * Route a Copilot tool-lifecycle hook (`preToolUse`, `permissionRequest`,
 * `postToolUse`, `postToolUseFailure`) through the per-tool waiting debounce.
 * Callers must NOT route the `exit_plan_mode`/`ask_user` `preToolUse` here.
 */
export function handleCopilotToolEvent(
	ptyId: string,
	event: string,
	toolName: string,
): void {
	const store = usePtyActivityStore.getState();
	switch (event) {
		case "preToolUse":
			// Tool about to run — amber, as before. (Fires before the gate.)
			store.applyHookEvent(ptyId, "active");
			break;
		case "permissionRequest": {
			// Don't go blue yet — start the debounce for this tool call.
			const gate: PendingGate = { timer: undefined, confirmed: false };
			queueFor(ptyId, toolName).push(gate);
			scheduleCheck(ptyId, gate);
			break;
		}
		case "postToolUse":
		case "postToolUseFailure": {
			// The tool finished → permission was granted (auto or by the user).
			const gate = shiftGate(ptyId, toolName);
			if (gate?.timer !== undefined) clearTimeout(gate.timer);
			// Return to amber unless another tool is still confirmed-waiting (so
			// the pane stays blue until every blocked tool resolves).
			if (!anyConfirmed(ptyId)) store.applyHookEvent(ptyId, "active");
			break;
		}
	}
}

/**
 * Cancel all outstanding gates for a PTY. Called on session-clear, terminal
 * teardown, and when the user answers a waiting prompt — so a stale timer can't
 * re-confirm a wait the user has already handled.
 */
export function cancelPendingForPty(ptyId: string): void {
	const byTool = pending.get(ptyId);
	if (!byTool) return;
	for (const queue of byTool.values()) {
		for (const gate of queue) {
			if (gate.timer !== undefined) clearTimeout(gate.timer);
		}
	}
	pending.delete(ptyId);
}

// The requests Rust forwards to this Window for **Agent control** (ADR-0054).
// Mirrors `Request` in `src-tauri/src/agent_control.rs`: tagged by `op`,
// fields in camelCase. Rust has already parsed and checked the arguments.

/** A pane addressed by an Agent: its **Pane number** or **Agent handle**. */
export type Target =
	| { kind: "pane"; value: number }
	| { kind: "handle"; value: string };

export type Direction = "right" | "down";
export type Until = "settled" | "ready" | "waiting" | "error";

export type ControlRequest =
	| { op: "resolve"; target: Target }
	| { op: "pane.list" }
	| { op: "pane.current" }
	| {
			op: "pane.read";
			target: Target;
			lines: number | null;
			visible: boolean;
	  }
	| { op: "pane.split"; direction: Direction | null; focus: boolean }
	| { op: "pane.run"; target: Target; command: string }
	| { op: "pane.close"; target: Target }
	| { op: "agent.list" }
	| {
			op: "agent.start";
			handle: string | null;
			kind: string;
			prompt: string | null;
			direction: Direction | null;
			args: string[];
			focus: boolean;
	  }
	| {
			op: "agent.prompt";
			target: Target;
			text: string;
			wait: boolean;
			timeoutMs: number | null;
	  }
	| {
			op: "agent.wait";
			target: Target;
			until: Until;
			timeoutMs: number | null;
	  }
	| { op: "agent.sendKeys"; target: Target; keys: string[] }
	| { op: "agent.rename"; target: Target; handle: string | null };

export interface ControlCaller {
	ptyId: string;
	paneId: string;
	workspaceId: string;
}

/** The error codes an Agent sees (`docs/plans/agent-control.md`). */
export type ControlErrorCode =
	| "not_found"
	| "out_of_reach"
	| "not_an_agent"
	| "handle_taken"
	| "invalid_handle"
	| "busy"
	| "state_unknown"
	| "stalled"
	| "not_owner"
	| "unsupported_shell"
	| "unsupported"
	| "empty_prompt"
	| "internal";

/** Thrown by a handler; becomes `{ error: { code, message } }`. */
export class ControlError extends Error {
	constructor(
		readonly code: ControlErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ControlError";
	}
}

/** How an Agent sees a pane's status: the glossary's words, not the
 *  store's legacy `active`. */
export type ControlStatus =
	| "idle"
	| "working"
	| "waiting"
	| "ready"
	| "error"
	| "exited";

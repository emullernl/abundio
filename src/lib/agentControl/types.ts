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
			/** Open in a new **Spawned tab** instead of a split. */
			tab: boolean;
			tabName: string | null;
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
	| { op: "agent.rename"; target: Target; handle: string | null }
	| { op: "tab.new"; name: string | null; focus: boolean }
	/** `target: null` is the caller's own Tab. */
	| { op: "tab.rename"; name: string; target: Target | null }
	// Round four (ADR-0056). `ask`, `notify`, `progress` and `worktree.new`
	// are for agent-mode callers only.
	| {
			op: "ask";
			question: string;
			choices: string[];
			/** Offer a text field (always when there are no choices). */
			text: boolean;
			timeoutMs: number | null;
	  }
	| { op: "notify"; message: string }
	/** `text: null` clears the **Progress line**. */
	| { op: "progress"; text: string | null }
	| {
			op: "worktree.new";
			branch: string;
			agent: AgentSpec | null;
			focus: boolean;
	  }
	| { op: "notes.read" }
	| { op: "notes.append"; text: string }
	| {
			op: "pane.watch";
			target: Target;
			/** A JavaScript regex, compiled here. */
			pattern: string;
			ignoreCase: boolean;
			timeoutMs: number | null;
	  };

/** The Agent `worktree new --agent` starts in the new Workspace. */
export interface AgentSpec {
	kind: string;
	prompt: string | null;
	handle: string | null;
	args: string[];
}

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
	| "folder_missing"
	/** The caller's pane runs no Agent, and this command speaks for one. */
	| "agents_only"
	| "invalid_pattern"
	| "branch_in_use"
	| "exists"
	| "cancelled"
	/** The user dismissed a Question card without answering. */
	| "declined"
	| "exited"
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

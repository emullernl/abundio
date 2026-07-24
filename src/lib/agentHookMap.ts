// Maps an Agent's lifecycle hook event to a status-indicator transition.
//
// Hooks are authoritative ground truth for Agent status — see
// docs/plans/agent-hooks-status-integration.md. "clear" means the Agent
// session ended (drop agent mode); "idle" means the user cancelled the turn
// (Kimi's Interrupt) — the pane goes straight to Idle, NOT Ready: the user
// just acted in the pane, so there is nothing unacknowledged, and an
// interrupt is not a clean finish (see CONTEXT.md's Ready definition).
// "resume" means "the agent is provably not blocked" (a tool is executing):
// it lifts Waiting → Working and is otherwise a strict no-op — unlike
// "active" it never resets the working window or drops a Subagent-held Stop,
// so it is safe for per-tool-call events. "attach" means "hooks are live in
// this PTY": it marks the PTY hook-driven (silencing the byte heuristic)
// without driving any state transition — for events that fire before any
// work starts, like Grok's SessionStart. The other values are
// PtyActivityState transitions.

export type HookTransition =
	| "active"
	| "waiting"
	| "ready"
	| "idle"
	| "error"
	| "resume"
	| "attach"
	| "clear";

// Per-agent (event name → transition). Event names match each Agent's own
// hook system; see the per-agent mapping table in the plan.
const HOOK_EVENT_MAP: Record<string, Record<string, HookTransition>> = {
	claude: {
		UserPromptSubmit: "active",
		PermissionRequest: "waiting",
		Stop: "ready",
		StopFailure: "error",
		SessionEnd: "clear",
	},
	copilot: {
		userPromptSubmitted: "active",
		// Copilot's genuine permission-block signal. Its `notification` hook is
		// provisioned with `matcher: "permission_prompt"` (see agent_hooks.rs),
		// so the only `notification` events that reach us are real prompts —
		// map them straight to "waiting". This replaces the old
		// `permissionRequest` + 1500ms debounce, which fired for every
		// permission-gated tool even on autopilot. The Waiting dot is held
		// against the prompt's own render output by a recordOutput guard in
		// ptyActivityStore, and cleared by the user's keystroke in
		// terminalManager — ESC dismisses to idle (clearWaiting); Enter/0-9
		// answers and goes straight to active (applyHookEvent), not via idle —
		// or by agentStop. See ADR-0015.
		notification: "waiting",
		// No default `preToolUse` mapping: it's provisioned ONLY for
		// exit_plan_mode/ask_user (matcher-scoped), and the COPILOT_WAITING_TOOLS
		// branch in mapHookEvent turns those into "waiting". preToolUse never
		// fires for other tools, and would map to null here if it did.
		agentStop: "ready",
		errorOccurred: "error",
		sessionEnd: "clear",
	},
	gemini: {
		BeforeAgent: "active",
		AfterAgent: "ready",
		Notification: "waiting",
		SessionEnd: "clear",
	},
	codex: {
		UserPromptSubmit: "active",
		PermissionRequest: "waiting",
		Stop: "ready",
	},
	opencode: {
		// "active" must come from a generation-only event. message.updated
		// also fires AFTER session.idle (finalising the message), which would
		// resurrect "active" on a finished turn. message.part.delta is token
		// streaming — it cannot fire once the session is idle.
		"message.part.delta": "active",
		"permission.replied": "active",
		"permission.asked": "waiting",
		// OpenCode raises a separate `question.*` event when the agent asks the
		// user a free-form question (distinct from a tool-permission gate).
		// Both block on the user, so they mirror the `permission.*` transitions.
		"question.replied": "active",
		"question.asked": "waiting",
		"session.idle": "ready",
		"session.error": "error",
		"session.deleted": "clear",
	},
};

HOOK_EVENT_MAP.kimi = {
	// Kimi Code uses Claude's hook vocabulary (Moonshot docs, hooks Beta) plus
	// two events Claude lacks, both provisioned (see agent_hooks.rs):
	// PermissionResult — the permission prompt was answered, the turn resumes —
	// and Interrupt — the user cancelled the turn, which is also why kimi keeps
	// the double-ESC default in escPressesToCancelAgent: the hook is the
	// authoritative cancel signal, the keystroke heuristic only a fallback.
	// PermissionResult likely fires on deny as well as grant (its payload isn't
	// split by outcome in the docs): on a deny the pane may read Working for a
	// beat before the ensuing Stop/StopFailure corrects it — accepted as
	// self-correcting. Confirm on the first live turn (hook-server log).
	UserPromptSubmit: "active",
	PermissionRequest: "waiting",
	PermissionResult: "active",
	Stop: "ready",
	StopFailure: "error",
	Interrupt: "idle",
	SessionEnd: "clear",
};

HOOK_EVENT_MAP.grok = {
	// Grok Build (xAI) reimplements Claude's hook schema (it can even load
	// .claude/settings.json), but Abundio provisions a standalone file in
	// ~/.grok/hooks/ — see GROK_EVENTS in agent_hooks.rs. Grok has no
	// PermissionRequest event; its Notification hook is provisioned
	// matcher-scoped to the two first-party blocking notification types
	// (permission_prompt | elicitation_dialog), so — like Copilot — only
	// genuine prompts reach the "waiting" mapping. Grok has NO
	// permission-granted event (unlike Kimi's PermissionResult). Crucially,
	// PreToolUse fires BEFORE the permission gate, not after it (verified
	// against grok-build tool_calls.rs: the PreToolUse dispatch precedes
	// `permissions.request_with_edit_path_context`), so within one tool call
	// the order is always PreToolUse → permission_prompt Notification —
	// PreToolUse can only heal the PREVIOUS tool's stale Waiting, never its
	// own. In `auto` (LLM classifier) mode the prompt usually self-resolves
	// with no keystroke and nothing fires after approval, which left the pane
	// stuck Waiting for the rest of the tool run; the envelope's
	// `permissionMode` field discriminates this — see the grok Notification
	// branch in mapHookEvent. PermissionDenied fires
	// AFTER a deny: the user (or policy) just acted and the turn continues,
	// so it resumes "active"; Stop/StopFailure corrects if the turn ends
	// instead. Stop is reason-branched in mapHookEvent (end_turn → ready,
	// cancelled → idle, error → error) because Grok fires a single Stop for
	// completed, cancelled, AND errored turns — and on errors it fires AFTER
	// StopFailure, so an unconditional "ready" would overwrite the Error
	// icon. Verified against github.com/xai-org/grok-build
	// (acp_session_impl/turn.rs).
	// SessionStart maps to "attach" (mark hook-driven, no state change):
	// Grok's welcome screen plays an animated logo that emits 8-10KB redraw
	// bursts every few seconds, which the byte heuristic reads as Working —
	// but no hook fires before the first prompt, so the heuristic stays live
	// exactly there. SessionStart lands ~100ms after launch (verified against
	// the 0.2.111 binary with a logging hook probe), flipping the PTY to
	// hook-driven before the first burst (~2s in).
	SessionStart: "attach",
	UserPromptSubmit: "active",
	Notification: "waiting",
	PreToolUse: "resume",
	PermissionDenied: "active",
	Stop: "ready",
	StopFailure: "error",
	SessionEnd: "clear",
};

// Qwen Code forked from Gemini CLI but has since adopted Claude-style hooks
// (verified against qwen 0.15.6: PascalCase UserPromptSubmit/Stop/StopFailure/
// SessionEnd etc., zero BeforeAgent/AfterAgent) — see
// docs/plans/subagent-aware-status.md.
HOOK_EVENT_MAP.qwen = HOOK_EVENT_MAP.claude;

// Copilot tools whose preToolUse IS the act of blocking on the user: running
// the tool presents a plan / question and waits for an answer. Copilot emits no
// `notification` for these (and no permissionRequest) — preToolUse is the only
// signal — so the tool name is the discriminator. preToolUse is provisioned
// matcher-scoped to exactly these tools (see agent_hooks.rs), so it doesn't
// fire for any other tool.
const COPILOT_WAITING_TOOLS = new Set(["exit_plan_mode", "ask_user"]);

// Grok permission_prompt messages that fire at the moment a modal dialog is
// actually shown — the exit_plan_mode approval ("Plan approval requested",
// tool_calls.rs request_plan_approval) and the diff-review UI ("Diff review
// requested", hook_dispatch.rs notification_hook_for_update). These always
// block on the user, in every permission mode — unlike the gate-entry
// "Tool permission requested", which fires BEFORE the permission resolves
// and frequently self-resolves (Read/Grep/WebSearch are unconditionally
// auto-allowed as SAFE_COMMAND in permission/manager.rs). The strings are
// stable literals in grok-build source.
const GROK_BLOCKING_PROMPT_MESSAGES = new Set([
	"Plan approval requested",
	"Diff review requested",
]);

/**
 * Resolve an Agent hook event to a status transition, or `null` when the
 * event is not one we drive status from.
 *
 * `toolName` (from the hook payload, when present) lets a specific tool
 * override the event's default transition — see the exit_plan_mode case.
 * `stopReason` (Grok's `Stop.reason` payload field) lets a turn-end event
 * distinguish how the turn ended — see the grok case.
 * `permissionMode` (Grok's envelope field: `default` | `auto` | `plan` |
 * `bypassPermissions`), `notificationType` (Grok's Notification payload
 * field), and `message` (the Notification's human-readable text — the only
 * field that separates Grok's dialog-on-screen prompts from its gate-entry
 * prompts) let a permission_prompt that will self-resolve map to "resume"
 * instead of "waiting" — see the grok Notification case.
 */
export function mapHookEvent(
	agentId: string,
	eventName: string,
	toolName?: string,
	stopReason?: string,
	permissionMode?: string,
	notificationType?: string,
	message?: string,
): HookTransition | null {
	// Grok's single Stop event covers completed, cancelled, and errored turns,
	// discriminated by `reason`. A user-cancel goes straight to Idle, not Ready
	// (CONTEXT.md: Ready = clean finish; same rationale as Kimi's Interrupt).
	// An errored turn must NOT map to "ready": Grok fires Stop AFTER
	// StopFailure on errors, and "ready" would overwrite the Error icon.
	// Unknown/missing reasons fall through to the map's default ("ready").
	// Grok fires the gate-entry permission_prompt notification BEFORE the
	// permission resolves, and nothing fires after an approval. Which of
	// them self-resolve depends on the mode and the tool:
	// - `auto` (LLM classifier) / `bypassPermissions`: (almost) all prompts
	//   self-resolve without a keystroke, so "waiting" would stick for the
	//   whole tool run (the next PreToolUse fires before the NEXT prompt's
	//   notification, so the pane read Waiting for essentially the entire
	//   turn). Suppress every gate-entry prompt.
	// - `plan`: Read/Grep/WebSearch are unconditionally auto-allowed
	//   (SAFE_COMMAND, permission/manager.rs) and dominate planning turns,
	//   which left panes falsely Waiting for most of a planning turn.
	//   Suppress gate-entry prompts here too — but only when `message`
	//   confirms gate entry, so older Grok binaries without the field keep
	//   the conservative "waiting".
	// - dialog-on-screen prompts (plan approval, diff review — see
	//   GROK_BLOCKING_PROMPT_MESSAGES) always block: "waiting" in EVERY
	//   mode, including auto/bypass where they were previously suppressed.
	// "resume" is a strict no-op unless Waiting, which also heals a stale
	// Waiting left by a mid-prompt Ctrl+O mode toggle.
	// Known trade-off: a genuine tool prompt in auto or plan mode (a
	// classifier escalation, an ungrated bash/MCP call) shares the
	// "Tool permission requested" message with the self-resolving case, so
	// it shows Working, not Waiting; the 30s hook-idle backstop flips it to
	// Ready as the attention signal. elicitation_dialog genuinely blocks
	// regardless of mode and keeps the "waiting" mapping.
	if (
		agentId === "grok" &&
		eventName === "Notification" &&
		notificationType === "permission_prompt" &&
		!(message !== undefined && GROK_BLOCKING_PROMPT_MESSAGES.has(message))
	) {
		if (permissionMode === "auto" || permissionMode === "bypassPermissions") {
			return "resume";
		}
		if (permissionMode === "plan" && message === "Tool permission requested") {
			return "resume";
		}
	}
	if (agentId === "grok" && eventName === "Stop") {
		if (stopReason === "cancelled") return "idle";
		if (stopReason === "error") return "error";
		return "ready";
	}
	// Copilot's preToolUse is provisioned only for the two tools whose execution
	// IS a prompt blocking on the user (exit_plan_mode's plan review, ask_user's
	// multiple-choice question) — those go to "waiting" until the user answers
	// (a keystroke then clears it). There is no default preToolUse mapping.
	if (
		agentId === "copilot" &&
		eventName === "preToolUse" &&
		toolName !== undefined &&
		COPILOT_WAITING_TOOLS.has(toolName)
	) {
		return "waiting";
	}
	return HOOK_EVENT_MAP[agentId]?.[eventName] ?? null;
}

// ── Subagent lifecycle events (ADR-0022, docs/plans/subagent-aware-status.md) ──
//
// These deliberately have NO entry in HOOK_EVENT_MAP: they carry a Subagent id,
// not a status transition, and are dispatched as subagentStarted/subagentStopped
// reducer events by the translator (terminalManager) before mapHookEvent runs.

export interface SubagentSignal {
	action: "started" | "stopped";
	id: string;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Classify a hook event as a Subagent start/stop signal, or `null` when it is
 * not one (fall through to `mapHookEvent`). `payload` is the parsed hook JSON
 * (undefined when unparseable); `hasSubagent` checks live-set membership — the
 * discriminator for OpenCode events whose payload lacks a `parentID`.
 *
 * Per agent:
 * - claude / qwen / codex / kimi: `SubagentStart` / `SubagentStop`, id = `agent_id`.
 * - grok: same PascalCase events, id = `subagentId` (camelCase — verified
 *   against xai-grok-hooks/src/event.rs in the open-source repo).
 * - copilot: `subagentStart` / `subagentStop`, id = `agentName` (no instance id
 *   exists; concurrent same-named subagents may release the hold early, and the
 *   built-in `general-purpose` agent emits neither event — accepted gaps).
 * - opencode: child sessions. `session.created`/`session.updated` with a truthy
 *   `parentID` → started; `session.idle`/`session.error`/`session.deleted` of a
 *   session in the live set → stopped (a child's idle/error must NOT drive the
 *   pane's own ready/error — that was the pre-existing mid-turn ready flash).
 */
export function mapSubagentHookEvent(
	agentId: string,
	eventName: string,
	payload: unknown,
	hasSubagent: (id: string) => boolean,
): SubagentSignal | null {
	const p = payload as Record<string, unknown> | undefined;
	if (
		agentId === "claude" ||
		agentId === "qwen" ||
		agentId === "codex" ||
		agentId === "kimi" ||
		agentId === "grok"
	) {
		if (eventName !== "SubagentStart" && eventName !== "SubagentStop") {
			return null;
		}
		const id = str(p?.agent_id) ?? str(p?.agentId) ?? str(p?.subagentId);
		if (!id) return null;
		return {
			action: eventName === "SubagentStart" ? "started" : "stopped",
			id,
		};
	}
	if (agentId === "copilot") {
		if (eventName !== "subagentStart" && eventName !== "subagentStop") {
			return null;
		}
		const id = str(p?.agentName);
		if (!id) return null;
		return {
			action: eventName === "subagentStart" ? "started" : "stopped",
			id,
		};
	}
	if (agentId === "opencode") {
		const info = p?.info as Record<string, unknown> | undefined;
		if (eventName === "session.created" || eventName === "session.updated") {
			const id = str(info?.id);
			if (id && str(info?.parentID)) return { action: "started", id };
			return null;
		}
		if (
			eventName === "session.idle" ||
			eventName === "session.error" ||
			eventName === "session.deleted"
		) {
			const id = str(p?.sessionID) ?? str(info?.id);
			if (id && hasSubagent(id)) return { action: "stopped", id };
			return null;
		}
	}
	return null;
}

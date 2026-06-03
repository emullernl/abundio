// Maps an Agent's lifecycle hook event to a status-indicator transition.
//
// Hooks are authoritative ground truth for Agent status — see
// docs/plans/agent-hooks-status-integration.md. "clear" means the Agent
// session ended (drop agent mode); the other values are PtyActivityState
// transitions.

export type HookTransition = "active" | "waiting" | "ready" | "error" | "clear";

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
		// Copilot fires permissionRequest for permission-gated tools (edits/
		// writes; read-kind tools like glob/view short-circuit it), even when
		// auto-approved, in the order preToolUse → permissionRequest →
		// postToolUse. So permissionRequest alone can't tell an auto-approved
		// tool from a genuine prompt at request time. This map resolves it to
		// "waiting", but terminalManager routes Copilot's tool-lifecycle events
		// through copilotWaitingDebounce, which only commits "waiting" once a
		// permissionRequest has gone 1500ms with no postToolUse AND the pane is
		// quiet — a genuine block. postToolUse / postToolUseFailure (the tool
		// ran → permission was granted) cancel the pending wait; a blocked tool
		// never fires them. postToolUseFailure (non-zero exit, e.g. grep
		// no-match) is "active", not "error": a failed tool is normal agent
		// flow. See ADR-0015.
		//
		// Other agents deliberately OMIT this: Claude/Codex PermissionRequest
		// and Gemini Notification fire only on a genuine prompt, cleared by the
		// user's keystroke (ESC → idle, Enter/0-9 → active). Don't add a
		// preToolUse/postToolUse mapping to them.
		permissionRequest: "waiting",
		preToolUse: "active",
		postToolUse: "active",
		postToolUseFailure: "active",
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

// Qwen Code is a Gemini CLI fork — identical hook events.
HOOK_EVENT_MAP.qwen = HOOK_EVENT_MAP.gemini;

// Copilot tools whose preToolUse IS the act of blocking on the user: running
// the tool presents a plan / question and waits for an answer. They must stay
// "waiting" rather than letting the default preToolUse → active pull the dot
// back. Copilot emits no permissionRequest for these — preToolUse is the only
// signal — so the tool name is the discriminator.
const COPILOT_WAITING_TOOLS = new Set(["exit_plan_mode", "ask_user"]);

/**
 * Resolve an Agent hook event to a status transition, or `null` when the
 * event is not one we drive status from.
 *
 * `toolName` (from the hook payload, when present) lets a specific tool
 * override the event's default transition — see the exit_plan_mode case.
 */
export function mapHookEvent(
	agentId: string,
	eventName: string,
	toolName?: string,
): HookTransition | null {
	// Copilot's preToolUse normally pulls the dot back to "active" once a tool
	// clears the permission gate. The exceptions are tools whose execution IS a
	// prompt blocking on the user (exit_plan_mode's plan review, ask_user's
	// multiple-choice question) — those stay "waiting" until the user answers
	// (a keystroke then clears it).
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

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
		// Copilot's genuine permission-block signal. Its `notification` hook is
		// provisioned with `matcher: "permission_prompt"` (see agent_hooks.rs),
		// so the only `notification` events that reach us are real prompts —
		// map them straight to "waiting". This replaces the old
		// `permissionRequest` + 1500ms debounce, which fired for every
		// permission-gated tool even on autopilot. The Waiting dot is held
		// against the prompt's own render output by a recordOutput guard in
		// ptyActivityStore, and cleared by the user's keystroke (ESC → idle,
		// Enter/0-9 → active) or agentStop. See ADR-0016 (supersedes ADR-0015).
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

// Qwen Code is a Gemini CLI fork — identical hook events.
HOOK_EVENT_MAP.qwen = HOOK_EVENT_MAP.gemini;

// Copilot tools whose preToolUse IS the act of blocking on the user: running
// the tool presents a plan / question and waits for an answer. Copilot emits no
// `notification` for these (and no permissionRequest) — preToolUse is the only
// signal — so the tool name is the discriminator. preToolUse is provisioned
// matcher-scoped to exactly these tools (see agent_hooks.rs), so it doesn't
// fire for any other tool.
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

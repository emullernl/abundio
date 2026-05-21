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
		// Copilot's permissionRequest fires before the permission service for
		// EVERY tool — not just user-prompted ones — so it needs preToolUse to
		// pull the dot back to active once a tool is cleared to run. An auto-
		// approved tool briefly flashes sky-blue between the two (accepted).
		//
		// Other agents deliberately OMIT this pairing: Claude/Codex
		// PermissionRequest and Gemini Notification fire only on a genuine
		// prompt, and the user's keystroke answering it clears waiting →
		// active. Don't add a preToolUse mapping to them.
		permissionRequest: "waiting",
		preToolUse: "active",
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
		"session.idle": "ready",
		"session.error": "error",
		"session.deleted": "clear",
	},
};

// Qwen Code is a Gemini CLI fork — identical hook events.
HOOK_EVENT_MAP.qwen = HOOK_EVENT_MAP.gemini;

/**
 * Resolve an Agent hook event to a status transition, or `null` when the
 * event is not one we drive status from.
 */
export function mapHookEvent(
	agentId: string,
	eventName: string,
): HookTransition | null {
	return HOOK_EVENT_MAP[agentId]?.[eventName] ?? null;
}

/**
 * The **Agent session id** an Agent hook reports for the Pane's own
 * conversation, or undefined when the event carries none (or carries a
 * Subagent's). What a **Session resume** reopens (ADR-0050).
 *
 * Field names were read from each Agent's source and docs; Claude Code and
 * Copilot were also confirmed live (docs/plans/session-resume.md):
 *
 * - `session_id`: Claude Code, Gemini, Codex, Qwen, Kimi, Vibe.
 * - `sessionId`: Copilot, Grok.
 * - `sessionID`: OpenCode 2.x, only on events its plugin tagged `scope: "self"`
 *   (the session on screen). 1.x is skipped: its payloads mix the Pane's
 *   session with child sessions and cannot be told apart from one event.
 *
 * Subagent ids are excluded where an Agent puts them in the session field:
 * Vibe's child events (`parent_session_id` set), and Copilot's `preToolUse`,
 * which runs inside a Subagent with the child's own id. Everywhere else a
 * Subagent event carries the parent's session id, which is the one we want.
 */
export function agentSessionIdFrom(
	agentId: string,
	eventName: string,
	payload: unknown,
): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	switch (agentId) {
		case "claude":
		case "gemini":
		case "codex":
		case "qwen":
		case "kimi":
			return str(p.session_id);
		case "vibe":
			return str(p.parent_session_id) ? undefined : str(p.session_id);
		case "copilot":
			return eventName === "preToolUse" ? undefined : str(p.sessionId);
		case "grok":
			return str(p.sessionId);
		case "opencode":
			return p.v === 2 && p.scope === "self" ? str(p.sessionID) : undefined;
		default:
			return undefined;
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

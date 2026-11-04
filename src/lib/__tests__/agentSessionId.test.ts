import { describe, expect, it } from "vitest";
import { agentSessionIdFrom } from "../agentSessionId";

const ID = "46f60052-b165-4f82-ba51-c42baebb9d3a";

describe("agentSessionIdFrom", () => {
	it("reads session_id for the snake_case Agents", () => {
		for (const agent of ["claude", "gemini", "codex", "qwen", "kimi", "vibe"]) {
			expect(
				agentSessionIdFrom(agent, "Stop", {
					session_id: ID,
					hook_event_name: "Stop",
				}),
				agent,
			).toBe(ID);
		}
	});

	it("reads Copilot's camelCase sessionId (live-test payload shape)", () => {
		const payload = {
			sessionId: ID,
			timestamp: 1,
			cwd: "/x",
			prompt: "hi",
		};
		expect(agentSessionIdFrom("copilot", "userPromptSubmitted", payload)).toBe(
			ID,
		);
		expect(agentSessionIdFrom("copilot", "agentStop", payload)).toBe(ID);
	});

	it("ignores Copilot's preToolUse, which can carry a Subagent's id", () => {
		expect(
			agentSessionIdFrom("copilot", "preToolUse", { sessionId: "child" }),
		).toBeUndefined();
	});

	it("reads Grok's sessionId", () => {
		expect(agentSessionIdFrom("grok", "Stop", { sessionId: ID })).toBe(ID);
	});

	it("ignores a Vibe Subagent's event", () => {
		expect(
			agentSessionIdFrom("vibe", "post_agent", {
				session_id: "child",
				parent_session_id: ID,
			}),
		).toBeUndefined();
		expect(
			agentSessionIdFrom("vibe", "post_agent", {
				session_id: ID,
				parent_session_id: null,
			}),
		).toBe(ID);
	});

	it("takes OpenCode 2.x's on-screen session only", () => {
		expect(
			agentSessionIdFrom("opencode", "session.execution.started", {
				v: 2,
				scope: "self",
				sessionID: "ses_abc",
			}),
		).toBe("ses_abc");
		expect(
			agentSessionIdFrom("opencode", "session.execution.started", {
				v: 2,
				scope: "child",
				sessionID: "ses_child",
			}),
		).toBeUndefined();
		expect(
			agentSessionIdFrom("opencode", "session.idle", { sessionID: "ses_1x" }),
		).toBeUndefined();
	});

	it("is undefined for a missing, empty or non-string id, or no payload", () => {
		expect(agentSessionIdFrom("claude", "Stop", {})).toBeUndefined();
		expect(agentSessionIdFrom("claude", "Stop", { session_id: "" })).toBe(
			undefined,
		);
		expect(
			agentSessionIdFrom("claude", "Stop", { session_id: 42 }),
		).toBeUndefined();
		expect(agentSessionIdFrom("claude", "Stop", undefined)).toBeUndefined();
		expect(agentSessionIdFrom("claude", "Stop", "text")).toBeUndefined();
	});

	it("is undefined for an Agent it does not know", () => {
		expect(
			agentSessionIdFrom("custom", "Stop", { session_id: ID }),
		).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { mapHookEvent } from "../agentHookMap";

describe("mapHookEvent", () => {
	it("maps Claude Code lifecycle events", () => {
		expect(mapHookEvent("claude", "UserPromptSubmit")).toBe("active");
		expect(mapHookEvent("claude", "PermissionRequest")).toBe("waiting");
		expect(mapHookEvent("claude", "Stop")).toBe("ready");
		expect(mapHookEvent("claude", "StopFailure")).toBe("error");
		expect(mapHookEvent("claude", "SessionEnd")).toBe("clear");
	});

	it("maps Copilot CLI events incl. permissionRequest/preToolUse", () => {
		expect(mapHookEvent("copilot", "userPromptSubmitted")).toBe("active");
		expect(mapHookEvent("copilot", "permissionRequest")).toBe("waiting");
		expect(mapHookEvent("copilot", "preToolUse")).toBe("active");
		expect(mapHookEvent("copilot", "agentStop")).toBe("ready");
		expect(mapHookEvent("copilot", "errorOccurred")).toBe("error");
	});

	it("keeps Copilot blocking tools in waiting despite preToolUse", () => {
		// exit_plan_mode blocks on the user's plan-review decision and ask_user
		// blocks on a multiple-choice answer — preToolUse must NOT flip the dot
		// back to active for these tools.
		expect(mapHookEvent("copilot", "preToolUse", "exit_plan_mode")).toBe(
			"waiting",
		);
		expect(mapHookEvent("copilot", "preToolUse", "ask_user")).toBe("waiting");
		// Any other tool keeps the default preToolUse → active.
		expect(mapHookEvent("copilot", "preToolUse", "bash")).toBe("active");
		expect(mapHookEvent("copilot", "preToolUse", "report_intent")).toBe(
			"active",
		);
		// The override is Copilot-specific and event-specific.
		expect(mapHookEvent("claude", "preToolUse", "ask_user")).toBeNull();
	});

	it("maps Gemini events and shares the map with Qwen", () => {
		expect(mapHookEvent("gemini", "BeforeAgent")).toBe("active");
		expect(mapHookEvent("gemini", "AfterAgent")).toBe("ready");
		expect(mapHookEvent("gemini", "Notification")).toBe("waiting");
		expect(mapHookEvent("qwen", "BeforeAgent")).toBe("active");
		expect(mapHookEvent("qwen", "AfterAgent")).toBe("ready");
	});

	it("maps Codex events", () => {
		expect(mapHookEvent("codex", "UserPromptSubmit")).toBe("active");
		expect(mapHookEvent("codex", "PermissionRequest")).toBe("waiting");
		expect(mapHookEvent("codex", "Stop")).toBe("ready");
	});

	it("maps OpenCode plugin events", () => {
		expect(mapHookEvent("opencode", "message.part.delta")).toBe("active");
		expect(mapHookEvent("opencode", "permission.asked")).toBe("waiting");
		expect(mapHookEvent("opencode", "permission.replied")).toBe("active");
		expect(mapHookEvent("opencode", "question.asked")).toBe("waiting");
		expect(mapHookEvent("opencode", "question.replied")).toBe("active");
		expect(mapHookEvent("opencode", "session.idle")).toBe("ready");
		expect(mapHookEvent("opencode", "session.error")).toBe("error");
		expect(mapHookEvent("opencode", "session.deleted")).toBe("clear");
		// message.updated is intentionally unmapped — it fires post-idle and
		// would resurrect "active" on a finished turn.
		expect(mapHookEvent("opencode", "message.updated")).toBeNull();
	});

	it("returns null for unknown agents and unmapped events", () => {
		expect(mapHookEvent("aider", "Stop")).toBeNull();
		expect(mapHookEvent("claude", "PreToolUse")).toBeNull();
		expect(mapHookEvent("totally-unknown", "whatever")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { mapHookEvent, mapSubagentHookEvent } from "../agentHookMap";

describe("mapHookEvent", () => {
	it("maps Claude Code lifecycle events", () => {
		expect(mapHookEvent("claude", "UserPromptSubmit")).toBe("active");
		expect(mapHookEvent("claude", "PermissionRequest")).toBe("waiting");
		expect(mapHookEvent("claude", "Stop")).toBe("ready");
		expect(mapHookEvent("claude", "StopFailure")).toBe("error");
		expect(mapHookEvent("claude", "SessionEnd")).toBe("clear");
	});

	it("drives Copilot Waiting from the notification hook, not permissionRequest", () => {
		expect(mapHookEvent("copilot", "userPromptSubmitted")).toBe("active");
		// notification reaches us only as permission_prompt (matcher-scoped at
		// provisioning), so it maps straight to waiting. See ADR-0015.
		expect(mapHookEvent("copilot", "notification")).toBe("waiting");
		expect(mapHookEvent("copilot", "agentStop")).toBe("ready");
		expect(mapHookEvent("copilot", "errorOccurred")).toBe("error");
		expect(mapHookEvent("copilot", "sessionEnd")).toBe("clear");
	});

	it("no longer maps Copilot's retired per-tool hooks", () => {
		// permissionRequest + the postToolUse/preToolUse-default dance (and the
		// copilotWaitingDebounce module) were removed with ADR-0015.
		expect(mapHookEvent("copilot", "permissionRequest")).toBeNull();
		expect(mapHookEvent("copilot", "postToolUse")).toBeNull();
		expect(mapHookEvent("copilot", "postToolUseFailure")).toBeNull();
		// preToolUse has no default mapping — only the two prompt-tools below.
		expect(mapHookEvent("copilot", "preToolUse")).toBeNull();
		expect(mapHookEvent("copilot", "preToolUse", "bash")).toBeNull();
	});

	it("keeps Copilot blocking tools (exit_plan_mode/ask_user) in waiting via preToolUse", () => {
		// These emit no notification; their preToolUse is provisioned
		// matcher-scoped and is the only signal, so it maps to waiting.
		expect(mapHookEvent("copilot", "preToolUse", "exit_plan_mode")).toBe(
			"waiting",
		);
		expect(mapHookEvent("copilot", "preToolUse", "ask_user")).toBe("waiting");
		// The override is Copilot-specific and event-specific.
		expect(mapHookEvent("claude", "preToolUse", "ask_user")).toBeNull();
	});

	it("maps Gemini events", () => {
		expect(mapHookEvent("gemini", "BeforeAgent")).toBe("active");
		expect(mapHookEvent("gemini", "AfterAgent")).toBe("ready");
		expect(mapHookEvent("gemini", "Notification")).toBe("waiting");
	});

	it("Qwen shares Claude's map, not Gemini's (qwen ≥0.15 speaks Claude-style hooks)", () => {
		expect(mapHookEvent("qwen", "UserPromptSubmit")).toBe("active");
		expect(mapHookEvent("qwen", "Stop")).toBe("ready");
		expect(mapHookEvent("qwen", "StopFailure")).toBe("error");
		expect(mapHookEvent("qwen", "SessionEnd")).toBe("clear");
		expect(mapHookEvent("qwen", "BeforeAgent")).toBeNull();
		expect(mapHookEvent("qwen", "AfterAgent")).toBeNull();
	});

	it("maps Kimi Code events (Claude vocabulary plus PermissionResult/Interrupt)", () => {
		expect(mapHookEvent("kimi", "UserPromptSubmit")).toBe("active");
		expect(mapHookEvent("kimi", "PermissionRequest")).toBe("waiting");
		// Kimi (unlike Claude) emits an explicit "prompt answered" resume.
		expect(mapHookEvent("kimi", "PermissionResult")).toBe("active");
		expect(mapHookEvent("kimi", "Stop")).toBe("ready");
		expect(mapHookEvent("kimi", "StopFailure")).toBe("error");
		expect(mapHookEvent("kimi", "SessionEnd")).toBe("clear");
	});

	it("maps Kimi's Interrupt to idle, never ready (user-cancel is acknowledged)", () => {
		// An interrupt is not a clean finish and the user just acted in the
		// pane — a Ready flash here would lie (see CONTEXT.md's Ready).
		expect(mapHookEvent("kimi", "Interrupt")).toBe("idle");
		// Unprovisioned noise stays unmapped.
		expect(mapHookEvent("kimi", "PreToolUse")).toBeNull();
		expect(mapHookEvent("kimi", "Notification")).toBeNull();
	});

	it("maps Grok Build events (Claude-compatible schema, Notification-driven waiting)", () => {
		// SessionStart fires ~100ms after launch, while the welcome screen is
		// up. "attach" flips the PTY to hook-driven with no state change, so
		// the welcome-screen logo animation (8-10KB redraw bursts) can no
		// longer trip the byte heuristic into Working.
		expect(mapHookEvent("grok", "SessionStart")).toBe("attach");
		expect(mapHookEvent("grok", "UserPromptSubmit")).toBe("active");
		// Notification is matcher-scoped at provisioning to
		// permission_prompt|elicitation_dialog, so only genuine blocking
		// prompts reach this mapping (Copilot-style, not Gemini-style).
		expect(mapHookEvent("grok", "Notification")).toBe("waiting");
		// PermissionDenied fires AFTER the deny — the turn continues.
		expect(mapHookEvent("grok", "PermissionDenied")).toBe("active");
		// PreToolUse is the resume-out-of-Waiting signal: Grok has no
		// permission-granted event, and prompts frequently resolve without a
		// local keystroke (always-approve mode, LLM classifier, remembered
		// grants, mid-prompt Ctrl+O, relay approvals). "resume" lifts Waiting
		// and is a no-op otherwise, so the per-tool-call frequency is safe.
		expect(mapHookEvent("grok", "PreToolUse")).toBe("resume");
		expect(mapHookEvent("grok", "StopFailure")).toBe("error");
		expect(mapHookEvent("grok", "SessionEnd")).toBe("clear");
		// Unprovisioned per-tool/compaction noise stays unmapped.
		expect(mapHookEvent("grok", "PostToolUse")).toBeNull();
		expect(mapHookEvent("grok", "PostToolUseFailure")).toBeNull();
		expect(mapHookEvent("grok", "PreCompact")).toBeNull();
		expect(mapHookEvent("grok", "PostCompact")).toBeNull();
	});

	it("resumes instead of waiting on Grok permission_prompts that self-resolve (auto/bypass modes)", () => {
		// Grok fires the permission_prompt notification BEFORE the permission
		// gate, and nothing fires after an approval (grok-build tool_calls.rs).
		// In auto (LLM classifier) mode the prompt self-resolves with no
		// keystroke, so "waiting" would stick for the whole tool run.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"auto",
				"permission_prompt",
			),
		).toBe("resume");
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"bypassPermissions",
				"permission_prompt",
			),
		).toBe("resume");
		// default mode genuinely blocks on the user.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"default",
				"permission_prompt",
			),
		).toBe("waiting");
		// Plan mode without a message (older Grok) keeps the conservative
		// "waiting" — suppression there requires the message to confirm a
		// gate-entry prompt (see the plan-mode test below).
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"plan",
				"permission_prompt",
			),
		).toBe("waiting");
		// An elicitation dialog blocks the user regardless of permission mode.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"auto",
				"elicitation_dialog",
			),
		).toBe("waiting");
		// Missing payload fields (older Grok, unparseable payload) keep the
		// conservative "waiting" mapping.
		expect(mapHookEvent("grok", "Notification")).toBe("waiting");
		// The suppression is Grok-specific — Copilot's notification is already
		// only emitted for genuine prompts.
		expect(
			mapHookEvent(
				"copilot",
				"notification",
				undefined,
				undefined,
				"auto",
				"permission_prompt",
			),
		).toBe("waiting");
	});

	it("resumes on plan-mode gate-entry prompts, holds waiting for on-screen dialogs", () => {
		// Planning turns are dominated by Read/Grep/WebSearch, which the
		// permission actor auto-allows unconditionally (SAFE_COMMAND,
		// grok-build permission/manager.rs) — but the gate-entry
		// permission_prompt ("Tool permission requested") fires BEFORE that
		// resolution, so panes read a false Waiting for most of the turn.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"plan",
				"permission_prompt",
				"Tool permission requested",
			),
		).toBe("resume");
		// The exit_plan_mode approval and diff-review dialogs fire their
		// permission_prompt at the moment the dialog is shown — they always
		// block, in every mode. Plan approval is itself an AccessKind::Read
		// (tool_calls.rs), so without the message discriminator plan-mode
		// suppression would hide plan mode's one guaranteed genuine block.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"plan",
				"permission_prompt",
				"Plan approval requested",
			),
		).toBe("waiting");
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"plan",
				"permission_prompt",
				"Diff review requested",
			),
		).toBe("waiting");
		// The dialog-on-screen messages outrank the auto/bypass suppression
		// too — a diff review escalated in auto mode must show Waiting
		// (narrows the trade-off documented on the auto-mode mapping).
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"auto",
				"permission_prompt",
				"Diff review requested",
			),
		).toBe("waiting");
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"bypassPermissions",
				"permission_prompt",
				"Plan approval requested",
			),
		).toBe("waiting");
		// Auto/bypass keep suppressing gate-entry prompts, with or without
		// the message field (older Grok binaries omit it).
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"auto",
				"permission_prompt",
				"Tool permission requested",
			),
		).toBe("resume");
		// Default mode stays untouched even with a gate-entry message —
		// bash/MCP prompts genuinely block there and are common.
		expect(
			mapHookEvent(
				"grok",
				"Notification",
				undefined,
				undefined,
				"default",
				"permission_prompt",
				"Tool permission requested",
			),
		).toBe("waiting");
	});

	it("branches Grok's Stop on its reason payload (end_turn/cancelled/error)", () => {
		// Grok fires a single Stop for every turn end, discriminated by reason.
		expect(mapHookEvent("grok", "Stop", undefined, "end_turn")).toBe("ready");
		// A user-cancel goes straight to Idle, never Ready (CONTEXT.md: Ready =
		// clean finish; same rationale as Kimi's Interrupt).
		expect(mapHookEvent("grok", "Stop", undefined, "cancelled")).toBe("idle");
		// Stop fires AFTER StopFailure on errored turns — "ready" here would
		// overwrite the Error icon.
		expect(mapHookEvent("grok", "Stop", undefined, "error")).toBe("error");
		// Missing/unknown reasons fall through to the map default.
		expect(mapHookEvent("grok", "Stop")).toBe("ready");
		expect(mapHookEvent("grok", "Stop", undefined, "future_reason")).toBe(
			"ready",
		);
		// The reason branch is Grok-specific — Claude's Stop ignores it.
		expect(mapHookEvent("claude", "Stop", undefined, "cancelled")).toBe(
			"ready",
		);
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

	it("has no transition mapping for subagent lifecycle events (they bypass it)", () => {
		// SubagentStart/SubagentStop carry an id, not a transition — the
		// translator dispatches them as reducer events (ADR-0022).
		expect(mapHookEvent("claude", "SubagentStart")).toBeNull();
		expect(mapHookEvent("claude", "SubagentStop")).toBeNull();
		expect(mapHookEvent("qwen", "SubagentStart")).toBeNull();
		expect(mapHookEvent("copilot", "subagentStart")).toBeNull();
	});
});

describe("mapSubagentHookEvent (ADR-0022)", () => {
	const never = () => false;
	const always = () => true;

	it("classifies Claude/Qwen/Codex/Kimi SubagentStart/Stop by agent_id", () => {
		for (const agent of ["claude", "qwen", "codex", "kimi"]) {
			expect(
				mapSubagentHookEvent(agent, "SubagentStart", { agent_id: "a1" }, never),
			).toEqual({ action: "started", id: "a1" });
			expect(
				mapSubagentHookEvent(agent, "SubagentStop", { agent_id: "a1" }, never),
			).toEqual({ action: "stopped", id: "a1" });
		}
		// camelCase payload tolerated.
		expect(
			mapSubagentHookEvent("claude", "SubagentStart", { agentId: "a2" }, never),
		).toEqual({ action: "started", id: "a2" });
	});

	it("classifies Grok SubagentStart/Stop by subagentId", () => {
		// Grok's payload field is `subagentId` (xai-grok-hooks/src/event.rs).
		expect(
			mapSubagentHookEvent(
				"grok",
				"SubagentStart",
				{ subagentId: "sub-1", subagentType: "explore" },
				never,
			),
		).toEqual({ action: "started", id: "sub-1" });
		expect(
			mapSubagentHookEvent(
				"grok",
				"SubagentStop",
				{ subagentId: "sub-1" },
				never,
			),
		).toEqual({ action: "stopped", id: "sub-1" });
		expect(mapSubagentHookEvent("grok", "SubagentStart", {}, never)).toBeNull();
	});

	it("classifies Copilot subagentStart/Stop by agentName", () => {
		expect(
			mapSubagentHookEvent(
				"copilot",
				"subagentStart",
				{ agentName: "explore" },
				never,
			),
		).toEqual({ action: "started", id: "explore" });
		expect(
			mapSubagentHookEvent(
				"copilot",
				"subagentStop",
				{ agentName: "explore" },
				never,
			),
		).toEqual({ action: "stopped", id: "explore" });
	});

	it("returns null on a missing/malformed id (never wedge on a bad payload)", () => {
		expect(
			mapSubagentHookEvent("claude", "SubagentStart", {}, never),
		).toBeNull();
		expect(
			mapSubagentHookEvent("claude", "SubagentStop", undefined, never),
		).toBeNull();
		expect(
			mapSubagentHookEvent(
				"copilot",
				"subagentStart",
				{ agentName: "" },
				never,
			),
		).toBeNull();
	});

	it("returns null for non-subagent events (falls through to mapHookEvent)", () => {
		expect(
			mapSubagentHookEvent("claude", "Stop", { agent_id: "a1" }, never),
		).toBeNull();
		expect(
			mapSubagentHookEvent(
				"gemini",
				"SubagentStart",
				{ agent_id: "a1" },
				never,
			),
		).toBeNull();
	});

	it("OpenCode: a child session's created/updated (parentID) is a start", () => {
		const child = { info: { id: "ses_child", parentID: "ses_main" } };
		expect(
			mapSubagentHookEvent("opencode", "session.created", child, never),
		).toEqual({ action: "started", id: "ses_child" });
		expect(
			mapSubagentHookEvent("opencode", "session.updated", child, never),
		).toEqual({ action: "started", id: "ses_child" });
		// The pane's own session (no parentID) is not a subagent.
		expect(
			mapSubagentHookEvent(
				"opencode",
				"session.created",
				{ info: { id: "ses_main" } },
				never,
			),
		).toBeNull();
	});

	it("OpenCode: idle/error/deleted of a session in the live set is a stop", () => {
		for (const event of ["session.idle", "session.error", "session.deleted"]) {
			expect(
				mapSubagentHookEvent(
					"opencode",
					event,
					{ sessionID: "ses_child" },
					always,
				),
			).toEqual({ action: "stopped", id: "ses_child" });
			// Unknown session → the pane's own lifecycle; falls through to
			// mapHookEvent (this was the pre-existing mid-turn ready flash fix:
			// a tracked child's idle no longer reaches the ready mapping).
			expect(
				mapSubagentHookEvent(
					"opencode",
					event,
					{ sessionID: "ses_main" },
					never,
				),
			).toBeNull();
		}
	});
});

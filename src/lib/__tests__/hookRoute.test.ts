import { describe, expect, it } from "vitest";
import {
	type HookRoute,
	mappedHookEventNames,
	OPENCODE_V2_EVENT_NAMES,
	OPENCODE_V2_SHOWN,
	routeHookEvent,
} from "../agentHookMap";
import { agentSessionIdFrom } from "../agentSessionId";
import fixture from "./fixtures/hookRoute.json";

/**
 * Every Agent's hook events, with the payload shapes and pane states each
 * rule reads, through the Window's `routeHookEvent` (and `agentSessionIdFrom`).
 * The cases are in `fixtures/hookRoute.json`, which Rust's `hook_route.rs`
 * replays and must match (docs/plans/remote-hosts.md phase 6d).
 *
 * Regenerate after a change:
 * `UPDATE_HOOK_ROUTE=1 npx vitest run src/lib/__tests__/hookRoute.test.ts`
 */

const NODE_FS = "node:fs";
const SID = "sess-1";

interface Case {
	agent: string;
	event: string;
	payload: unknown;
	live: string[];
	titleStatusSeen: boolean;
	openCodeCancelled: boolean;
	expected: HookRoute & { sessionId: string | null };
}

const EXTRA_EVENTS: Record<string, string[]> = {
	claude: ["SubagentStart", "SubagentStop", "SessionStart", "Nope"],
	qwen: ["SubagentStart", "SubagentStop"],
	codex: ["SubagentStart", "SubagentStop"],
	kimi: ["SubagentStart", "SubagentStop"],
	grok: ["SubagentStart", "SubagentStop"],
	copilot: ["subagentStart", "subagentStop", "preToolUse", "permissionRequest"],
	gemini: ["Nope"],
	opencode: [
		"session.created",
		"session.updated",
		"session.status",
		"session.error",
		"session.idle",
		"session.deleted",
		"permission.updated",
		"permission.replied",
		"message.updated",
		...OPENCODE_V2_EVENT_NAMES,
		OPENCODE_V2_SHOWN,
	],
	vibe: ["pre_tool", "post_tool"],
	nobody: ["Stop"],
};

function payloads(agent: string): unknown[] {
	const base: unknown[] = [undefined, {}, { session_id: SID, sessionId: SID }];
	switch (agent) {
		case "claude":
		case "qwen":
		case "codex":
		case "kimi":
			return [
				...base,
				{ agent_id: "s1", session_id: SID },
				{ agentId: "s1" },
				{ agent_id: "" },
			];
		case "grok": {
			const out = [...base, { subagentId: "s1", sessionId: SID }];
			for (const reason of ["end_turn", "cancelled", "error", undefined]) {
				out.push({ reason });
			}
			for (const permissionMode of [
				"default",
				"auto",
				"plan",
				"bypassPermissions",
				undefined,
			]) {
				for (const notificationType of [
					"permission_prompt",
					"elicitation_dialog",
				]) {
					for (const message of [
						"Tool permission requested",
						"Plan approval requested",
						"Diff review requested",
						undefined,
					]) {
						out.push({ permissionMode, notificationType, message });
					}
				}
			}
			return out;
		}
		case "copilot":
			return [
				...base,
				{ toolName: "exit_plan_mode", sessionId: SID },
				{ toolName: "ask_user" },
				{ toolName: "bash" },
				{ agentName: "reviewer" },
				{ agentName: "" },
			];
		case "opencode":
			return [
				...base,
				{ status: { type: "busy" } },
				{ status: { type: "retry" } },
				{ status: { type: "idle" } },
				{ error: { name: "MessageAbortedError" } },
				{ error: { name: "APIError" } },
				{ info: { id: "s1", parentID: "root" } },
				{ info: { id: "root" } },
				{ sessionID: "s1" },
				{ sessionID: "other" },
				{ v: 2, scope: "self", sessionID: SID },
				{ v: 2, scope: "child", sessionID: "s1" },
				{ v: 2, scope: "child" },
				{ v: 2, scope: "other", sessionID: SID },
				{ v: 2, running: true, waiting: true },
				{ v: 2, running: true },
				{ v: 2, running: false, waiting: true },
			];
		case "vibe":
			return [
				...base,
				{ parent_session_id: "p", session_id: "c" },
				{ parent_session_id: "p" },
			];
		default:
			return base;
	}
}

function states(agent: string): [string[], boolean, boolean][] {
	if (agent === "opencode") {
		return [
			[[], true, false],
			[["s1"], true, false],
			[[], true, true],
			[["s1"], true, true],
		];
	}
	if (agent === "vibe")
		return [
			[[], false, false],
			[[], true, false],
		];
	return [[[], true, false]];
}

function generate(): Case[] {
	const cases: Case[] = [];
	for (const agent of Object.keys(EXTRA_EVENTS)) {
		const events = [
			...new Set([...mappedHookEventNames(agent), ...EXTRA_EVENTS[agent]]),
		];
		for (const event of events) {
			for (const payload of payloads(agent)) {
				for (const [live, titleStatusSeen, openCodeCancelled] of states(
					agent,
				)) {
					const route = routeHookEvent(agent, event, payload, {
						hasSubagent: (id) => live.includes(id),
						titleStatusSeen,
						openCodeCancelled,
					});
					cases.push(
						JSON.parse(
							JSON.stringify({
								agent,
								event,
								payload: payload ?? null,
								live,
								titleStatusSeen,
								openCodeCancelled,
								expected: {
									...route,
									sessionId: agentSessionIdFrom(agent, event, payload) ?? null,
								},
							}),
						),
					);
				}
			}
		}
	}
	return cases;
}

describe("hook routing", () => {
	const cases = generate();

	it("covers every kind of step, and every reason to drop", () => {
		const kinds = new Set(
			cases.flatMap((c) => c.expected.steps.map((s) => s.kind)),
		);
		expect(kinds).toEqual(
			new Set([
				"transition",
				"subagentStarted",
				"subagentStopped",
				"sessionEnd",
			]),
		);
		const dropped = new Set(
			cases.map((c) => c.expected.dropped).filter(Boolean),
		);
		expect(dropped).toEqual(
			new Set(["unmapped", "no_title_status", "cancel_gate"]),
		);
	});

	it("turns OpenCode 2.x's session switch into an end, then where the new one is", () => {
		const r = routeHookEvent(
			"opencode",
			OPENCODE_V2_SHOWN,
			{ v: 2, running: true, waiting: true },
			{
				hasSubagent: () => false,
				titleStatusSeen: true,
				openCodeCancelled: false,
			},
		);
		expect(
			r.steps.map((s) => (s.kind === "transition" ? s.transition : s.kind)),
		).toEqual(["sessionEnd", "active", "waiting"]);
	});

	it("matches the fixture Rust replays", async () => {
		const proc = (
			globalThis as {
				process?: { env?: Record<string, string>; cwd(): string };
			}
		).process;
		if (proc?.env?.UPDATE_HOOK_ROUTE) {
			const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
				writeFileSync(path: string, data: string): void;
			};
			fs.writeFileSync(
				`${proc.cwd()}/src/lib/__tests__/fixtures/hookRoute.json`,
				`${JSON.stringify({ _comment: "Generated by hookRoute.test.ts; replayed by hook_route.rs.", cases })}\n`,
			);
			return;
		}
		expect(cases).toEqual((fixture as unknown as { cases: Case[] }).cases);
	});
});

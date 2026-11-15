import { describe, expect, it } from "vitest";
import {
	agentRelaunchCommandFor,
	BUILTIN_AGENTS,
	isSafeSessionId,
	mergeAgentsWithBuiltins,
	type RelaunchOptions,
} from "../agents";
import type { CodingAgent } from "../types";

const ID = "4f3d4bed-f865-4d18-ae8e-f420c373cd18";
const base: RelaunchOptions = {
	resume: true,
};
const cmd = (agentId: string, opts: Partial<RelaunchOptions> = {}) =>
	agentRelaunchCommandFor(BUILTIN_AGENTS, agentId, { ...base, ...opts });

describe("agentRelaunchCommandFor", () => {
	it("resumes the remembered session by id", () => {
		expect(cmd("claude", { sessionId: ID })).toBe(`claude --resume ${ID}`);
	});

	it("substitutes an id inside an element (Copilot)", () => {
		expect(cmd("copilot", { sessionId: ID })).toBe(`copilot --resume=${ID}`);
	});

	it("puts Codex's resume subcommand after the command", () => {
		expect(cmd("codex", { sessionId: ID })).toBe(`codex resume ${ID}`);
	});

	it("starts fresh with no id: there is no continue-latest fallback", () => {
		for (const a of BUILTIN_AGENTS) {
			expect(cmd(a.id), a.id).toBe(a.command);
		}
	});

	it("starts fresh when the setting is off", () => {
		expect(cmd("claude", { sessionId: ID, resume: false })).toBe("claude");
	});

	it("treats an id that is not shell-safe as no id", () => {
		expect(cmd("claude", { sessionId: "x; rm -rf ~" })).toBe("claude");
	});

	it("never adds a fallback: a shell cannot tell a failed resume from a quit", () => {
		expect(cmd("copilot", { sessionId: ID })).not.toContain("||");
	});

	it("is undefined for an Agent that no longer exists", () => {
		expect(cmd("gone", { sessionId: ID })).toBeUndefined();
		expect(
			agentRelaunchCommandFor(BUILTIN_AGENTS, undefined, base),
		).toBeUndefined();
	});

	it("keeps an Agent's args", () => {
		const agents: CodingAgent[] = [
			{
				id: "c",
				name: "C",
				command: "claude",
				args: ["--model", "opus"],
				resumeArgs: ["--resume", "{session}"],
				builtin: false,
				enabled: true,
			},
		];
		expect(
			agentRelaunchCommandFor(agents, "c", { ...base, sessionId: ID }),
		).toBe(`claude --model opus --resume ${ID}`);
	});

	it("starts fresh for an Agent with no resume forms", () => {
		const agents: CodingAgent[] = [
			{ id: "x", name: "X", command: "x", builtin: false, enabled: true },
		];
		expect(
			agentRelaunchCommandFor(agents, "x", {
				...base,
				sessionId: ID,
			}),
		).toBe("x");
	});
});

describe("BUILTIN_AGENTS resume forms", () => {
	it("every built-in can resume by id", () => {
		for (const a of BUILTIN_AGENTS) {
			expect(a.resumeArgs?.join(" ").split("{session}").length, a.id).toBe(2);
		}
	});

	it("drops a saved custom Agent's legacy continue form", () => {
		const legacy = {
			id: "mine",
			name: "Mine",
			command: "my-agent",
			continueArgs: ["-c"],
			builtin: false,
			enabled: true,
		} as CodingAgent;
		const mine = mergeAgentsWithBuiltins([legacy]).find((a) => a.id === "mine");
		expect(mine).toBeDefined();
		expect(mine).not.toHaveProperty("continueArgs");
		expect(mine?.command).toBe("my-agent");
	});

	it("come from code, not the saved copy", () => {
		const merged = mergeAgentsWithBuiltins([
			{
				id: "claude",
				name: "Claude Code",
				command: "claude",
				resumeArgs: ["--stale", "{session}"],
				builtin: true,
				enabled: false,
			},
		]);
		const claude = merged.find((a) => a.id === "claude");
		expect(claude?.resumeArgs).toEqual(["--resume", "{session}"]);
		expect(claude?.enabled).toBe(false);
	});
});

describe("isSafeSessionId", () => {
	it("accepts every built-in's id shape and rejects shell syntax", () => {
		for (const id of [ID, "ses_abc123", `session_${ID}`]) {
			expect(isSafeSessionId(id)).toBe(true);
		}
		for (const id of [
			"",
			"a b",
			"a;b",
			"$(x)",
			"a`b",
			"x".repeat(129),
			// A leading `-` would be read as an option by resume flags that
			// take an optional value.
			"-p",
			"--yolo",
			"--dangerously-skip-permissions",
			"_x",
		]) {
			expect(isSafeSessionId(id)).toBe(false);
		}
		expect(isSafeSessionId(undefined)).toBe(false);
	});
});

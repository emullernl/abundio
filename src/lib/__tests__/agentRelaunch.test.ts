import { describe, expect, it } from "vitest";
import {
	agentRelaunchCommandFor,
	BUILTIN_AGENTS,
	isSafeSessionId,
	mergeAgentsWithBuiltins,
	parseContinueArgsForm,
	type RelaunchOptions,
	shellSupportsOrFallback,
} from "../agents";
import type { CodingAgent } from "../types";

const ID = "4f3d4bed-f865-4d18-ae8e-f420c373cd18";
const base: RelaunchOptions = {
	alone: false,
	resume: true,
	shell: "/bin/zsh",
};
const cmd = (agentId: string, opts: Partial<RelaunchOptions> = {}) =>
	agentRelaunchCommandFor(BUILTIN_AGENTS, agentId, { ...base, ...opts });

describe("agentRelaunchCommandFor", () => {
	it("resumes the remembered session by id, falling back to fresh", () => {
		expect(cmd("claude", { sessionId: ID })).toBe(
			`claude --resume ${ID} || claude`,
		);
	});

	it("substitutes an id inside an element (Copilot)", () => {
		expect(cmd("copilot", { sessionId: ID })).toBe(
			`copilot --resume=${ID} || copilot`,
		);
	});

	it("puts Codex's resume subcommand after the command", () => {
		expect(cmd("codex", { sessionId: ID })).toBe(`codex resume ${ID} || codex`);
		expect(cmd("codex", { alone: true })).toBe("codex resume --last || codex");
	});

	it("prefers the id over continue-latest when both apply", () => {
		expect(cmd("claude", { sessionId: ID, alone: true })).toBe(
			`claude --resume ${ID} || claude`,
		);
	});

	it("continues the folder's latest session only when the pane is alone", () => {
		expect(cmd("claude", { alone: true })).toBe("claude --continue || claude");
		expect(cmd("gemini", { alone: true })).toBe(
			"gemini --resume latest || gemini",
		);
		expect(cmd("claude", { alone: false })).toBe("claude");
	});

	it("starts fresh when the setting is off", () => {
		expect(cmd("claude", { sessionId: ID, alone: true, resume: false })).toBe(
			"claude",
		);
	});

	it("treats an id that is not shell-safe as no id", () => {
		expect(cmd("claude", { sessionId: "x; rm -rf ~" })).toBe("claude");
		expect(cmd("claude", { sessionId: "x; rm -rf ~", alone: true })).toBe(
			"claude --continue || claude",
		);
	});

	it("starts fresh in a shell without ||, or an unknown shell", () => {
		expect(cmd("claude", { sessionId: ID, shell: "/usr/bin/nu" })).toBe(
			"claude",
		);
		expect(cmd("claude", { sessionId: ID, shell: "powershell.exe" })).toBe(
			"claude",
		);
		expect(cmd("claude", { sessionId: ID, shell: null })).toBe("claude");
	});

	it("is undefined for an Agent that no longer exists", () => {
		expect(cmd("gone", { sessionId: ID })).toBeUndefined();
		expect(
			agentRelaunchCommandFor(BUILTIN_AGENTS, undefined, base),
		).toBeUndefined();
	});

	it("keeps an Agent's args in both halves", () => {
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
		).toBe(`claude --model opus --resume ${ID} || claude --model opus`);
	});

	it("uses a custom Agent's continue args only when alone", () => {
		const agents: CodingAgent[] = [
			{
				id: "mine",
				name: "Mine",
				command: "my-agent",
				continueArgs: ["-c"],
				builtin: false,
				enabled: true,
			},
		];
		const opts = { ...base, sessionId: ID };
		expect(agentRelaunchCommandFor(agents, "mine", opts)).toBe("my-agent");
		expect(
			agentRelaunchCommandFor(agents, "mine", { ...opts, alone: true }),
		).toBe("my-agent -c || my-agent");
	});

	it("starts fresh for an Agent with no resume forms", () => {
		const agents: CodingAgent[] = [
			{ id: "x", name: "X", command: "x", builtin: false, enabled: true },
		];
		expect(
			agentRelaunchCommandFor(agents, "x", {
				...base,
				sessionId: ID,
				alone: true,
			}),
		).toBe("x");
	});
});

describe("BUILTIN_AGENTS resume forms", () => {
	it("every built-in can resume by id and continue the latest", () => {
		for (const a of BUILTIN_AGENTS) {
			expect(a.resumeArgs?.join(" ").split("{session}").length, a.id).toBe(2);
			expect(a.continueArgs?.length, a.id).toBeGreaterThan(0);
		}
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
		for (const id of ["", "a b", "a;b", "$(x)", "a`b", "x".repeat(129)]) {
			expect(isSafeSessionId(id)).toBe(false);
		}
		expect(isSafeSessionId(undefined)).toBe(false);
	});
});

describe("shellSupportsOrFallback", () => {
	it("matches on the binary name", () => {
		for (const s of [
			"/bin/zsh",
			"/bin/bash",
			"C:\\Program Files\\Git\\bin\\BASH.EXE",
			"/opt/homebrew/bin/fish",
			"/bin/sh",
			"cmd.exe",
			"pwsh",
		]) {
			expect(shellSupportsOrFallback(s), s).toBe(true);
		}
		for (const s of ["powershell.exe", "/usr/bin/nu", "/bin/csh", null]) {
			expect(shellSupportsOrFallback(s), String(s)).toBe(false);
		}
	});
});

describe("parseContinueArgsForm", () => {
	it("splits a form into args; empty means none", () => {
		expect(parseContinueArgsForm(" --continue  --quiet ")).toEqual({
			continueArgs: ["--continue", "--quiet"],
		});
		expect(parseContinueArgsForm("   ")).toEqual({ continueArgs: undefined });
	});

	it("refuses placeholders", () => {
		expect(parseContinueArgsForm("--resume {session}")).toHaveProperty("error");
		expect(parseContinueArgsForm("-i {prompt}")).toHaveProperty("error");
	});
});

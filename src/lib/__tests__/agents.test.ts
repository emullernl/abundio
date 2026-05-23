import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENTS,
	escPressesToCancelAgent,
	getEnabledAgentCommands,
	matchProcessToAgent,
	matchTitleToAgent,
	mergeAgentsWithBuiltins,
} from "../agents";
import type { CodingAgent } from "../types";

describe("BUILTIN_AGENTS", () => {
	it("contains expected agents", () => {
		const commands = BUILTIN_AGENTS.map((a) => a.command);
		expect(commands).toContain("claude");
		expect(commands).toContain("copilot");
		expect(commands).toContain("gemini");
		expect(commands).toContain("aider");
		expect(commands).toContain("codex");
		expect(commands).toContain("opencode");
		expect(commands).toContain("qwen");
	});

	it("all builtins are enabled by default", () => {
		for (const agent of BUILTIN_AGENTS) {
			expect(agent.enabled).toBe(true);
			expect(agent.builtin).toBe(true);
		}
	});
});

describe("escPressesToCancelAgent", () => {
	it("returns 1 for agents that interrupt on a single ESC", () => {
		expect(escPressesToCancelAgent("claude")).toBe(1);
		expect(escPressesToCancelAgent("gemini")).toBe(1);
		expect(escPressesToCancelAgent("qwen")).toBe(1);
	});

	it("returns 2 for agents that require double-ESC", () => {
		expect(escPressesToCancelAgent("copilot")).toBe(2);
		expect(escPressesToCancelAgent("aider")).toBe(2);
		expect(escPressesToCancelAgent("codex")).toBe(2);
		expect(escPressesToCancelAgent("opencode")).toBe(2);
	});

	it("defaults to 2 for unknown or undefined agents", () => {
		expect(escPressesToCancelAgent(undefined)).toBe(2);
		expect(escPressesToCancelAgent("some-custom-agent")).toBe(2);
	});
});

describe("matchTitleToAgent", () => {
	const agents = BUILTIN_AGENTS;

	it("matches exact command as terminal title", () => {
		const result = matchTitleToAgent("claude", agents);
		expect(result?.command).toBe("claude");
	});

	it("matches command in a path title", () => {
		const result = matchTitleToAgent("/usr/local/bin/claude", agents);
		expect(result?.command).toBe("claude");
	});

	it("matches command with trailing space/args", () => {
		const result = matchTitleToAgent("aider --model gpt-4", agents);
		expect(result?.command).toBe("aider");
	});

	it("returns null for empty title", () => {
		expect(matchTitleToAgent("", agents)).toBeNull();
	});

	it("returns null for non-matching title", () => {
		expect(matchTitleToAgent("vim main.ts", agents)).toBeNull();
	});

	it("does not match substrings (avoids false positives)", () => {
		expect(matchTitleToAgent("claudette", agents)).toBeNull();
	});

	it("skips disabled agents", () => {
		const modified = agents.map((a) =>
			a.command === "claude" ? { ...a, enabled: false } : a,
		);
		expect(matchTitleToAgent("claude", modified)).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = matchTitleToAgent("Claude", agents);
		expect(result?.command).toBe("claude");
	});

	it("matches command preceded by backslash (Windows path)", () => {
		const result = matchTitleToAgent("C:\\Users\\bin\\codex", agents);
		expect(result?.command).toBe("codex");
	});
});

describe("matchProcessToAgent", () => {
	const agents = BUILTIN_AGENTS;

	it("matches exact process name", () => {
		const result = matchProcessToAgent("claude", agents);
		expect(result?.command).toBe("claude");
	});

	it("is case-insensitive", () => {
		const result = matchProcessToAgent("Claude", agents);
		expect(result?.command).toBe("claude");
	});

	it("returns null for empty name", () => {
		expect(matchProcessToAgent("", agents)).toBeNull();
	});

	it("returns null for non-matching process", () => {
		expect(matchProcessToAgent("vim", agents)).toBeNull();
	});

	it("does not match substrings", () => {
		expect(matchProcessToAgent("claudette", agents)).toBeNull();
	});

	it("skips disabled agents", () => {
		const modified = agents.map((a) =>
			a.command === "claude" ? { ...a, enabled: false } : a,
		);
		expect(matchProcessToAgent("claude", modified)).toBeNull();
	});
});

describe("getEnabledAgentCommands", () => {
	it("returns only enabled agent commands", () => {
		const agents: CodingAgent[] = [
			{ id: "1", name: "A", command: "a", builtin: true, enabled: true },
			{ id: "2", name: "B", command: "b", builtin: true, enabled: false },
			{ id: "3", name: "C", command: "c", builtin: false, enabled: true },
		];
		expect(getEnabledAgentCommands(agents)).toEqual(["a", "c"]);
	});
});

describe("mergeAgentsWithBuiltins", () => {
	it("preserves enabled state from persisted", () => {
		const persisted = BUILTIN_AGENTS.map((a) =>
			a.id === "claude" ? { ...a, enabled: false } : a,
		);
		const merged = mergeAgentsWithBuiltins(persisted);
		const claude = merged.find((a) => a.id === "claude");
		expect(claude?.enabled).toBe(false);
	});

	it("adds new builtins not in persisted", () => {
		const persisted = BUILTIN_AGENTS.filter((a) => a.id !== "opencode");
		const merged = mergeAgentsWithBuiltins(persisted);
		const opencode = merged.find((a) => a.id === "opencode");
		expect(opencode).toBeDefined();
		expect(opencode?.enabled).toBe(true);
	});

	it("keeps user-added custom agents", () => {
		const custom: CodingAgent = {
			id: "custom-1",
			name: "My Agent",
			command: "myagent",
			builtin: false,
			enabled: true,
		};
		const persisted = [...BUILTIN_AGENTS, custom];
		const merged = mergeAgentsWithBuiltins(persisted);
		expect(merged.find((a) => a.id === "custom-1")).toBeDefined();
	});

	it("does not duplicate builtins", () => {
		const merged = mergeAgentsWithBuiltins(BUILTIN_AGENTS);
		const claudeCount = merged.filter((a) => a.id === "claude").length;
		expect(claudeCount).toBe(1);
	});
});

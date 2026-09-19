import { describe, expect, it } from "vitest";
import { seedWatchedFromInstalled } from "../agentSeeding";
import type { CodingAgent } from "../types";

function builtin(id: string, enabled: boolean): CodingAgent {
	return { id, name: id, command: id, builtin: true, enabled };
}

function custom(id: string, command: string, enabled: boolean): CodingAgent {
	return { id, name: id, command, builtin: false, enabled };
}

describe("seedWatchedFromInstalled", () => {
	it("switches a built-in on when its command is installed", () => {
		const result = seedWatchedFromInstalled(
			[builtin("claude", false)],
			new Set(["claude"]),
		);
		expect(result[0].enabled).toBe(true);
	});

	it("switches a built-in off when its command is not installed", () => {
		const result = seedWatchedFromInstalled(
			[builtin("claude", true), builtin("aider", true)],
			new Set(["claude"]),
		);
		expect(result.map((a) => a.enabled)).toEqual([true, false]);
	});

	it("never touches a custom agent, installed or not", () => {
		const agents = [
			builtin("claude", true),
			custom("mine", "my-agent", true),
			custom("other", "claude", false),
		];
		const result = seedWatchedFromInstalled(agents, new Set(["claude"]));
		expect(result[1].enabled).toBe(true);
		expect(result[2].enabled).toBe(false);
	});

	// An empty scan means the login shell timed out far more often than it
	// means the machine has no coding CLIs. See ADR-0037.
	it("treats an empty installed set as a failed scan and changes nothing", () => {
		const agents = [builtin("claude", true), builtin("aider", true)];
		const result = seedWatchedFromInstalled(agents, new Set());
		expect(result).toBe(agents);
	});

	// Callers use the identity check to skip a store write, a hook
	// re-provision and a cross-Window broadcast.
	it("returns the same array when the toggles already match", () => {
		const agents = [builtin("claude", true), builtin("aider", false)];
		const result = seedWatchedFromInstalled(agents, new Set(["claude"]));
		expect(result).toBe(agents);
	});

	it("returns a new array when something changed", () => {
		const agents = [builtin("claude", false)];
		const result = seedWatchedFromInstalled(agents, new Set(["claude"]));
		expect(result).not.toBe(agents);
		expect(agents[0].enabled).toBe(false);
	});

	it("matches on the command, not the agent id", () => {
		const agents = [
			{
				id: "claude",
				name: "Claude Code",
				command: "claude-code",
				builtin: true,
				enabled: false,
			},
		];
		expect(
			seedWatchedFromInstalled(agents, new Set(["claude"]))[0].enabled,
		).toBe(false);
		expect(
			seedWatchedFromInstalled(agents, new Set(["claude-code"]))[0].enabled,
		).toBe(true);
	});
});

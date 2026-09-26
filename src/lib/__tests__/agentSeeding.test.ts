import { describe, expect, it } from "vitest";
import {
	pruneRetiredBuiltins,
	seedWatchedFromInstalled,
} from "../agentSeeding";
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
			[builtin("claude", true), builtin("codex", true)],
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
		const agents = [builtin("claude", true), builtin("codex", true)];
		const result = seedWatchedFromInstalled(agents, new Set());
		expect(result).toBe(agents);
	});

	// Callers use the identity check to skip a store write, a hook
	// re-provision and a cross-Window broadcast.
	it("returns the same array when the toggles already match", () => {
		const agents = [builtin("claude", true), builtin("codex", false)];
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

describe("pruneRetiredBuiltins", () => {
	const retired = (id: string): CodingAgent => ({
		...custom(id, id, true),
		retiredBuiltin: true,
	});
	const scanned = new Set(["claude", "codex", "aider"]);

	it("un-Watches a converted agent whose command is not installed", () => {
		const result = pruneRetiredBuiltins(
			[builtin("claude", true), retired("aider")],
			new Set(["claude"]),
			scanned,
		);
		expect(result).toEqual([
			builtin("claude", true),
			custom("aider", "aider", false),
		]);
		expect("retiredBuiltin" in result[1]).toBe(false);
	});

	it("keeps an installed one Watched and clears its marker", () => {
		const result = pruneRetiredBuiltins(
			[builtin("claude", true), retired("aider")],
			new Set(["claude", "aider"]),
			scanned,
		);
		expect(result[1]).toEqual(custom("aider", "aider", true));
		expect("retiredBuiltin" in result[1]).toBe(false);
	});

	it("returns the same reference on an empty scan", () => {
		const agents = [builtin("claude", true), retired("aider")];
		expect(pruneRetiredBuiltins(agents, new Set(), scanned)).toBe(agents);
	});

	it("returns the same reference when nothing carries the marker", () => {
		const agents = [builtin("claude", true), custom("aider", "aider", true)];
		expect(pruneRetiredBuiltins(agents, new Set(["claude"]), scanned)).toBe(
			agents,
		);
	});

	// A scan that never looked up `aider` says nothing about whether it is
	// installed, so its absence from `installed` must not un-Watch it.
	it("leaves a marked agent alone when the scan did not look up its command", () => {
		const agents = [builtin("claude", true), retired("aider")];
		expect(
			pruneRetiredBuiltins(agents, new Set(["claude"]), new Set(["claude"])),
		).toBe(agents);
	});

	it("never touches unmarked agents, even with the same command", () => {
		const mine = custom("custom-1", "aider", true);
		const off = builtin("codex", true);
		const result = pruneRetiredBuiltins(
			[off, mine, retired("aider")],
			new Set(["claude"]),
			scanned,
		);
		expect(result[0]).toBe(off);
		expect(result[1]).toBe(mine);
		expect(result[2].enabled).toBe(false);
	});
});

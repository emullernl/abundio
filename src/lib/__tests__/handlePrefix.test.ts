import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../agents";
import {
	BUILTIN_HANDLE_PREFIXES,
	handlePrefixFor,
	isFallbackDefault,
	isValidPrefix,
} from "../handlePrefix";

describe("handlePrefixFor", () => {
	it("gives every built-in its own word", () => {
		for (const a of BUILTIN_AGENTS) {
			expect(BUILTIN_HANDLE_PREFIXES[a.id], a.id).toBeDefined();
			expect(isValidPrefix(BUILTIN_HANDLE_PREFIXES[a.id]), a.id).toBe(true);
		}
		expect(handlePrefixFor("claude", [])).toBe("Claude");
		expect(handlePrefixFor("copilot", [])).toBe("Copilot");
		expect(handlePrefixFor("vibe", [])).toBe("Mistral");
	});

	it("takes a custom Agent's first word, else Agent", () => {
		const agents = [
			{ id: "c1", name: "Aider Pro" },
			{ id: "c2", name: "9 lives" },
			{ id: "c3", name: "  " },
			{ id: "c4", name: "My!Tool" },
		];
		expect(handlePrefixFor("c1", agents)).toBe("Aider");
		expect(handlePrefixFor("c2", agents)).toBe("Agent");
		expect(handlePrefixFor("c3", agents)).toBe("Agent");
		expect(handlePrefixFor("c4", agents)).toBe("Agent");
	});

	it("is Agent when the Agent is not known", () => {
		expect(handlePrefixFor(undefined, [])).toBe("Agent");
		expect(handlePrefixFor("gone", [])).toBe("Agent");
	});
});

describe("isFallbackDefault", () => {
	it("is only the digit form of Agent", () => {
		expect(isFallbackDefault("Agent 3")).toBe(true);
		expect(isFallbackDefault("agent-12")).toBe(true);
		expect(isFallbackDefault("Agent Three")).toBe(false);
		expect(isFallbackDefault("Claude 1")).toBe(false);
		expect(isFallbackDefault("Agent")).toBe(false);
	});
});

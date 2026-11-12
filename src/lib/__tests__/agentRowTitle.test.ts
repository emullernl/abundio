import { describe, expect, it } from "vitest";
import { agentRowTitle } from "../agentRowTitle";

describe("agentRowTitle", () => {
	it("uses the Agent's own terminal title", () => {
		expect(
			agentRowTitle({ agentName: "Claude Code", xtermTitle: "Fix the build" }),
		).toBe("Fix the build");
	});
	it("falls back to the Agent's name when no title is set", () => {
		expect(agentRowTitle({ agentName: "Codex", xtermTitle: "" })).toBe("Codex");
	});
	it("treats a whitespace-only title as no title", () => {
		expect(agentRowTitle({ agentName: "Codex", xtermTitle: "   " })).toBe(
			"Codex",
		);
	});
});

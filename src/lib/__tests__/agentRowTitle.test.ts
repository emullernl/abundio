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

describe("agentRowTitle with a handle", () => {
	it("leads with the handle, then the title or name", () => {
		expect(
			agentRowTitle({ agentName: "Codex", xtermTitle: "Fix", handle: "rev" }),
		).toBe("rev · Fix");
		expect(
			agentRowTitle({ agentName: "Codex", xtermTitle: " ", handle: "rev" }),
		).toBe("rev · Codex");
	});
});

import { describe, expect, it } from "vitest";
import { agentRowText, agentRowTitle } from "../agentRowTitle";

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

const base = {
	agentName: "Codex",
	xtermTitle: "Fix the build",
	handle: "Agent Two",
	workspaceName: "alpha",
	tabName: "Main",
};

describe("agentRowText", () => {
	it("puts the handle first and the title second", () => {
		const t = agentRowText(base);
		expect(t.primary).toBe("Agent Two");
		expect(t.secondary).toBe("Fix the build");
		expect(t.location).toBe("alpha · Main");
	});
	it("shows the Agent's name until it has a handle", () => {
		expect(agentRowText({ ...base, handle: undefined }).primary).toBe("Codex");
	});
	it("second line falls back to the Agent's name with no title", () => {
		expect(agentRowText({ ...base, xtermTitle: "  " }).secondary).toBe("Codex");
	});
	it("a Progress line wins the second line", () => {
		expect(agentRowText({ ...base, progress: "3/5 tests" }).secondary).toBe(
			"3/5 tests",
		);
	});
	it("tooltip leads with the location, then name, title, progress, flag", () => {
		const t = agentRowText({
			...base,
			progress: "3/5 tests",
			flagMessage: "Need a key",
		});
		expect(t.tooltip.split("\n")).toEqual([
			"Workspace alpha · Tab Main",
			"Codex",
			"Fix the build",
			"3/5 tests",
			"Wants your attention: Need a key",
		]);
	});
	it("tooltip leaves out the name when a line already shows it", () => {
		const t = agentRowText({ ...base, xtermTitle: "" });
		expect(t.tooltip).toBe("Workspace alpha · Tab Main");
	});
});

import { describe, expect, it } from "vitest";
import { sectionSummary } from "../sectionSummary";

const agent = (
	counts: Partial<
		Record<"error" | "waiting" | "ready" | "working" | "idle", number>
	>,
) => ({
	agent: {
		status: "green" as const,
		counts: { error: 0, waiting: 0, ready: 0, working: 0, idle: 0, ...counts },
	},
	terminal: null,
});

describe("sectionSummary", () => {
	it("counts the Workspaces and the Agents by status, most urgent first", () => {
		expect(sectionSummary(3, agent({ working: 2, waiting: 1, idle: 4 }))).toBe(
			"3 workspaces · 1 waiting · 2 working",
		);
		expect(sectionSummary(1, agent({ error: 1, ready: 2 }))).toBe(
			"1 workspace · 1 error · 2 ready",
		);
	});
	it("says only the count when no Agent is busy", () => {
		expect(sectionSummary(0, undefined)).toBe("0 workspaces");
		expect(sectionSummary(2, agent({ idle: 3 }))).toBe("2 workspaces");
	});
});

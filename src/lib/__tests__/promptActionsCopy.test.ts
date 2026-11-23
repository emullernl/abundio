import { describe, expect, it } from "vitest";
import { actionsToCopy } from "../promptActionsCopy";
import type { PromptActionRow } from "../types";

const row = (
	name: string,
	body: string,
	position: number,
	agents: string[] = [],
): PromptActionRow => ({
	id: `${name}-${position}`,
	name,
	body,
	scopeKind: agents.length ? "set" : "all",
	scopeAgentIds: agents,
	paramsJson: "[]",
	showInBar: true,
	position,
	createdAt: 0,
	updatedAt: 0,
});

describe("actionsToCopy", () => {
	it("copies what this computer lacks, in the Host's order, never a double", () => {
		const host = [
			row("Review", "Review this", 2),
			row("Fix", "Fix the tests", 1, ["opencode", "claude"]),
			row("Same", "Already here", 0),
		];
		const mine = [row("Same", "Already here", 5)];
		expect(actionsToCopy(host, mine).map((a) => a.name)).toEqual([
			"Fix",
			"Review",
		]);
		// A second run finds both now present.
		const after = [
			...mine,
			row("Fix", "Fix the tests", 6, ["claude", "opencode"]),
			row("Review", "Review this", 7),
		];
		expect(actionsToCopy(host, after)).toEqual([]);
	});
});

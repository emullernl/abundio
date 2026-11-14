import { describe, expect, it } from "vitest";
import { isOrchestrator, workWorkspaces } from "../workspaceKind";

describe("workspaceKind", () => {
	it("treats a missing kind as work", () => {
		expect(isOrchestrator({ id: "a" })).toBe(false);
		expect(isOrchestrator(null)).toBe(false);
		expect(isOrchestrator({ id: "a", kind: "work" })).toBe(false);
		expect(isOrchestrator({ id: "o", kind: "orchestrator" })).toBe(true);
	});

	it("drops only the Orchestrator workspace and keeps the order", () => {
		const list = [
			{ id: "a" },
			{ id: "o", kind: "orchestrator" as const },
			{ id: "b", kind: "work" as const },
		];
		expect(workWorkspaces(list).map((w) => w.id)).toEqual(["a", "b"]);
	});
});

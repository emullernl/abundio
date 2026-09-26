import { describe, expect, it } from "vitest";
import {
	setPendingAgent,
	setPendingTask,
	takePendingAgent,
	takePendingTask,
} from "../pendingAgentRegistry";

describe("pending tasks", () => {
	it("are taken once", () => {
		setPendingTask("p1", { argv: ["claude", "x"], agentId: "claude" });
		expect(takePendingTask("p1")).toEqual({
			argv: ["claude", "x"],
			agentId: "claude",
		});
		expect(takePendingTask("p1")).toBeUndefined();
	});

	// The task's shell runs the Agent; a typed launch would start a second one.
	it("clear a pending typed command for the same pane", () => {
		setPendingAgent("p2", { command: "claude" });
		setPendingTask("p2", { argv: ["claude", "x"], agentId: "claude" });
		expect(takePendingAgent("p2")).toBeUndefined();
		expect(takePendingTask("p2")).toBeDefined();
	});
});

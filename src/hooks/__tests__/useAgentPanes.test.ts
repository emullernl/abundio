import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { agentModeKey } from "../useAgentPanes";

const act = (mode: "agent" | "shell") =>
	({ detectionMode: mode }) as PtyActivityEntry;

describe("agentModeKey", () => {
	it("lists the agent-mode ptyIds, sorted", () => {
		expect(
			agentModeKey({ b: act("agent"), c: act("shell"), a: act("agent") }),
		).toBe("a|b");
	});

	it("follows a new activities object", () => {
		const first = { a: act("agent") };
		expect(agentModeKey(first)).toBe("a");
		expect(agentModeKey({ ...first, a: act("shell") })).toBe("");
	});

	it("does not re-scan the same activities object", () => {
		let reads = 0;
		const activities = {} as Record<string, PtyActivityEntry>;
		Object.defineProperty(activities, "x", {
			enumerable: true,
			get: () => {
				reads++;
				return act("agent");
			},
		});
		agentModeKey(activities);
		agentModeKey(activities);
		expect(reads).toBe(1);
	});
});

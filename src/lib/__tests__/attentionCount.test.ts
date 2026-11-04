import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { attentionCount } from "../attentionCount";

function entry(
	state: PtyActivityEntry["state"],
	detectionMode: PtyActivityEntry["detectionMode"],
): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
		shellCommandRunning: false,
	};
}

describe("attentionCount", () => {
	it("is zero with no PTYs", () => {
		expect(attentionCount({})).toBe(0);
	});

	it.each([
		["waiting", "agent", 1],
		["ready", "agent", 1],
		["error", "agent", 1],
		["error", "shell", 1],
		["active", "agent", 0],
		["active", "shell", 0],
		["idle", "agent", 0],
		["idle", "shell", 0],
	] as const)("%s %s counts %i", (state, mode, expected) => {
		expect(attentionCount({ p: entry(state, mode) })).toBe(expected);
	});

	it("adds up every PTY that wants attention", () => {
		expect(
			attentionCount({
				a: entry("waiting", "agent"),
				b: entry("ready", "agent"),
				c: entry("error", "agent"),
				d: entry("error", "shell"),
				e: entry("active", "agent"),
				f: entry("idle", "shell"),
			}),
		).toBe(4);
	});
});

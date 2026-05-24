import { describe, expect, it } from "vitest";
import { classifyShellExit, recordThresholdHit } from "../activityGate";

describe("recordThresholdHit", () => {
	it("does not fire on the first hit", () => {
		const result = recordThresholdHit([], 1000, 10_000, 3);
		expect(result.fire).toBe(false);
		expect(result.hitTimes).toEqual([1000]);
	});

	it("does not fire on the second hit", () => {
		const result = recordThresholdHit([1000], 2000, 10_000, 3);
		expect(result.fire).toBe(false);
		expect(result.hitTimes).toEqual([1000, 2000]);
	});

	it("fires on the third hit within the window and resets the list", () => {
		const result = recordThresholdHit([1000, 2000], 3000, 10_000, 3);
		expect(result.fire).toBe(true);
		expect(result.hitTimes).toEqual([]);
	});

	it("does not fire when the oldest hit falls outside the window", () => {
		// Hits at 0 and 5000, new hit at 11_000 with a 10s window —
		// the hit at 0 is pruned, leaving only [5000, 11_000].
		const result = recordThresholdHit([0, 5000], 11_000, 10_000, 3);
		expect(result.fire).toBe(false);
		expect(result.hitTimes).toEqual([5000, 11_000]);
	});

	it("fires when three hits straddle but all remain within the window", () => {
		// Hits at 1000 and 9000, new hit at 10_500 with a 10s window —
		// 1000 is still inside (cutoff = 500), so all three count.
		const result = recordThresholdHit([1000, 9000], 10_500, 10_000, 3);
		expect(result.fire).toBe(true);
		expect(result.hitTimes).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const input = [1000, 2000];
		recordThresholdHit(input, 3000, 10_000, 3);
		expect(input).toEqual([1000, 2000]);
	});
});

describe("classifyShellExit", () => {
	it("reports a non-zero exit as an error regardless of the activity setting", () => {
		expect(classifyShellExit(1, false)).toBe("error");
		expect(classifyShellExit(1, true)).toBe("error");
		expect(classifyShellExit(127, false)).toBe("error");
		expect(classifyShellExit(139, false)).toBe("error");
	});

	it("treats Ctrl+C (130) and SIGTERM (143) as a clean stop, not an error", () => {
		expect(classifyShellExit(130, false)).toBe("none");
		expect(classifyShellExit(143, false)).toBe("none");
		expect(classifyShellExit(130, true)).toBe("success");
		expect(classifyShellExit(143, true)).toBe("success");
	});

	it("surfaces a clean (zero) exit as success only when activity status is on", () => {
		expect(classifyShellExit(0, true)).toBe("success");
		expect(classifyShellExit(0, false)).toBe("none");
	});

	it("treats a missing or null exit code as a clean exit, gated by the setting", () => {
		expect(classifyShellExit(undefined, true)).toBe("success");
		expect(classifyShellExit(undefined, false)).toBe("none");
		expect(classifyShellExit(null, true)).toBe("success");
		expect(classifyShellExit(null, false)).toBe("none");
	});
});

import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { attentionCount, createAttentionReporter } from "../attentionCount";

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

describe("createAttentionReporter", () => {
	function setup() {
		let enabled = true;
		let activities: Record<string, PtyActivityEntry> = {
			a: entry("waiting", "agent"),
		};
		const sent: number[] = [];
		const report = createAttentionReporter(
			() => enabled,
			() => activities,
			(n) => sent.push(n),
		);
		return {
			report,
			sent,
			setEnabled: (v: boolean) => {
				enabled = v;
			},
			setActivities: (v: Record<string, PtyActivityEntry>) => {
				activities = v;
			},
		};
	}

	it("reports once on start", () => {
		const r = setup();
		r.report();
		expect(r.sent).toEqual([1]);
	});

	it("does not send again when the count is unchanged", () => {
		const r = setup();
		r.report();
		r.setActivities({ b: entry("ready", "agent"), c: entry("idle", "shell") });
		r.report();
		expect(r.sent).toEqual([1]);
	});

	it("sends a new count when it changes", () => {
		const r = setup();
		r.report();
		r.setActivities({});
		r.report();
		expect(r.sent).toEqual([1, 0]);
	});

	it("reports 0 when disabled and the current count when re-enabled", () => {
		const r = setup();
		r.report();
		r.setEnabled(false);
		r.report();
		r.setEnabled(true);
		r.report();
		expect(r.sent).toEqual([1, 0, 1]);
	});
});

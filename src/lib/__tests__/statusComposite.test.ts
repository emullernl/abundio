import { describe, expect, it } from "vitest";
import type {
	KindRollup,
	Rollups,
	StatusCounts,
} from "../../stores/ptyActivityStore";
import {
	BADGE_OVERHANG,
	BADGE_SIZE,
	COMPOSITE_WIDTH,
	compositeParts,
	compositeTooltip,
	PRIMARY_SIZE,
} from "../statusComposite";

function counts(partial: Partial<StatusCounts>): StatusCounts {
	return { error: 0, waiting: 0, ready: 0, working: 0, idle: 0, ...partial };
}

const agent = (
	status: KindRollup["status"],
	c: Partial<StatusCounts>,
): KindRollup => ({ status, counts: counts(c) });

const terminal = agent;

const NONE: Rollups = { agent: null, terminal: null };

describe("compositeParts — which rollup leads", () => {
	it("gives the primary to the Agent rollup whenever any Agent exists", () => {
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("cyan", { working: 1 }),
		};
		expect(compositeParts(r).primary).toEqual({
			kind: "agent",
			rollup: r.agent,
		});
	});

	it("never lets a terminal Error displace the primary", () => {
		// The big icon always answers the same question. A shell Error is a red
		// badge on a calm green circle, not a red primary (ADR-0033).
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("red", { error: 1 }),
		};
		const { primary, badge } = compositeParts(r);
		expect(primary?.kind).toBe("agent");
		expect(primary?.rollup.status).toBe("green");
		expect(badge?.status).toBe("red");
	});

	it("promotes the Terminal rollup when there are no Agents", () => {
		const r: Rollups = {
			agent: null,
			terminal: terminal("cyan", { working: 1 }),
		};
		expect(compositeParts(r).primary).toEqual({
			kind: "terminal",
			rollup: r.terminal,
		});
	});

	it("draws nothing when there are no PTYs of either kind", () => {
		expect(compositeParts(NONE)).toEqual({ primary: null, badge: null });
	});
});

describe("compositeParts — when the badge appears", () => {
	it("badges a terminal Error", () => {
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("red", { error: 1 }),
		};
		expect(compositeParts(r).badge?.status).toBe("red");
	});

	it("badges a terminal that is Working", () => {
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("cyan", { working: 1 }),
		};
		expect(compositeParts(r).badge?.status).toBe("cyan");
	});

	it("does NOT badge an idle terminal", () => {
		// Idle shells are the normal case; a badge for them would be permanent
		// furniture rather than a signal.
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("green", { idle: 3 }),
		};
		expect(compositeParts(r).badge).toBeNull();
	});

	it("does NOT badge when there is no Terminal rollup at all", () => {
		const r: Rollups = {
			agent: agent("amber", { working: 1 }),
			terminal: null,
		};
		expect(compositeParts(r).badge).toBeNull();
	});

	it("does NOT badge when the Terminal rollup is already the primary", () => {
		// Suppression belongs to the badge, not the rollup — as the primary it
		// still shows Idle, and it must not also appear on its own corner.
		const r: Rollups = {
			agent: null,
			terminal: terminal("red", { error: 1 }),
		};
		const { primary, badge } = compositeParts(r);
		expect(primary?.kind).toBe("terminal");
		expect(badge).toBeNull();
	});

	it("badges a mixed terminal rollup that holds any Error or Working", () => {
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("cyan", { working: 1, idle: 4 }),
		};
		expect(compositeParts(r).badge?.status).toBe("cyan");
	});
});

describe("compositeTooltip", () => {
	it("gives one line per present rollup", () => {
		const r: Rollups = {
			agent: agent("skyblue", { waiting: 2, working: 1, idle: 3 }),
			terminal: terminal("cyan", { working: 1, idle: 2 }),
		};
		expect(compositeTooltip(r)).toBe(
			"Agents: 2 Waiting · 1 Working · 3 Idle\nTerminals: 1 Working · 2 Idle",
		);
	});

	it("still reports an idle terminal that draws no badge", () => {
		// The only place a Terminal Idle count is always visible — what keeps
		// "my terminals are fine" and "I have no terminals" apart.
		const r: Rollups = {
			agent: agent("green", { idle: 1 }),
			terminal: terminal("green", { idle: 2 }),
		};
		expect(compositeTooltip(r)).toBe("Agents: 1 Idle\nTerminals: 2 Idle");
	});

	it("omits an absent rollup's line entirely", () => {
		const r: Rollups = {
			agent: agent("amber", { working: 1 }),
			terminal: null,
		};
		expect(compositeTooltip(r)).toBe("Agents: 1 Working");
	});

	it("is empty when nothing is drawn", () => {
		expect(compositeTooltip(NONE)).toBe("");
	});
});

describe("geometry", () => {
	it("reserves the badge's overhang in the composite's width", () => {
		// Or the badge would collide with the name beside it in the 56px strip.
		expect(COMPOSITE_WIDTH).toBe(PRIMARY_SIZE + BADGE_OVERHANG);
	});

	it("keeps the badge smaller than the primary", () => {
		expect(BADGE_SIZE).toBeLessThan(PRIMARY_SIZE);
	});
});

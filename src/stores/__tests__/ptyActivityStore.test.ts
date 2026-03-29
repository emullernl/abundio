import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	usePtyActivityStore,
	collectPtyIds,
	computeSessionDotStatus,
	computeTabDotStatus,
	computePtyDotStatus,
	shouldPulse,
	type PtyActivityEntry,
} from "../ptyActivityStore";
import type { PaneNode, Tab } from "../../lib/types";

function resetStore() {
	usePtyActivityStore.setState({
		activities: {},
		titles: {},
		panePtyMap: {},
		openedSessionIds: new Set(),
	});
}

beforeEach(() => {
	resetStore();
});

describe("store actions", () => {
	it("initPty creates an idle entry", () => {
		usePtyActivityStore.getState().initPty("pty-1");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.state).toBe("idle");
		expect(entry.hasEverReceivedOutput).toBe(true);
		expect(entry.lastOutputAt).toBeNull();
	});

	it("initPty is idempotent", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		initPty("pty-1");
		// Should still be active, not reset to idle
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe("active");
	});

	it("recordOutput transitions to active", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.state).toBe("active");
		expect(entry.lastOutputAt).not.toBeNull();
	});

	it("recordOutput when already active updates lastOutputAt", () => {
		const { initPty, recordOutput } = usePtyActivityStore.getState();
		initPty("pty-1");
		vi.setSystemTime(1000);
		recordOutput("pty-1");
		vi.setSystemTime(2000);
		recordOutput("pty-1");
		// lastOutputAt is mutated directly (no set()), check the value
		const entry = usePtyActivityStore.getState().activities["pty-1"];
		expect(entry.lastOutputAt).toBe(2000);
	});

	it("markIdle transitions to idle", () => {
		const { initPty, recordOutput, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordOutput("pty-1");
		markIdle("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe("idle");
	});

	it("markIdle is no-op when already idle", () => {
		const { initPty, markIdle } = usePtyActivityStore.getState();
		initPty("pty-1");
		markIdle("pty-1"); // should not throw
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe("idle");
	});

	it("recordError transitions to error", () => {
		const { initPty, recordError } = usePtyActivityStore.getState();
		initPty("pty-1");
		recordError("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"].state).toBe("error");
	});

	it("registerPane / removePane", () => {
		const { registerPane, removePane, setTitle } = usePtyActivityStore.getState();
		registerPane("pane-1", "pty-1");
		setTitle("pane-1", "bash");
		expect(usePtyActivityStore.getState().panePtyMap["pane-1"]).toBe("pty-1");
		expect(usePtyActivityStore.getState().titles["pane-1"]).toBe("bash");

		removePane("pane-1");
		expect(usePtyActivityStore.getState().panePtyMap["pane-1"]).toBeUndefined();
		expect(usePtyActivityStore.getState().titles["pane-1"]).toBeUndefined();
	});

	it("setTitle skips update for same title", () => {
		const { setTitle } = usePtyActivityStore.getState();
		setTitle("pane-1", "bash");
		const stateBefore = usePtyActivityStore.getState();
		setTitle("pane-1", "bash");
		// No new state object should have been created
		expect(usePtyActivityStore.getState().titles).toBe(stateBefore.titles);
	});

	it("markSessionOpened adds to set", () => {
		usePtyActivityStore.getState().markSessionOpened("s1");
		expect(usePtyActivityStore.getState().openedSessionIds.has("s1")).toBe(true);
	});

	it("removePty removes activity entry", () => {
		const { initPty, removePty } = usePtyActivityStore.getState();
		initPty("pty-1");
		removePty("pty-1");
		expect(usePtyActivityStore.getState().activities["pty-1"]).toBeUndefined();
	});
});


describe("collectPtyIds", () => {
	it("collects ptyId from terminal node", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(collectPtyIds(node)).toEqual(["pty-1"]);
	});

	it("returns empty for terminal with no ptyId", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
		expect(collectPtyIds(node)).toEqual([]);
	});

	it("uses panePtyMap fallback", () => {
		const node: PaneNode = { type: "terminal", id: "p1", ptyId: "" };
		expect(collectPtyIds(node, { p1: "pty-mapped" })).toEqual(["pty-mapped"]);
	});

	it("collects from split nodes", () => {
		const node: PaneNode = {
			type: "split", id: "s1", direction: "horizontal", ratio: 0.5,
			first: { type: "terminal", id: "p1", ptyId: "pty-1" },
			second: { type: "terminal", id: "p2", ptyId: "pty-2" },
		};
		expect(collectPtyIds(node)).toEqual(["pty-1", "pty-2"]);
	});
});

describe("computeSessionDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
	});

	it("returns grey when no ptyIds", () => {
		expect(computeSessionDotStatus("s1", [], {}, new Set())).toBe("grey");
	});

	it("returns red when any error", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeSessionDotStatus("s1", [layout], { "pty-1": makeEntry("error") }, new Set())).toBe("red");
	});

	it("returns blue when any active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeSessionDotStatus("s1", [layout], { "pty-1": makeEntry("active") }, new Set())).toBe("amber");
	});

	it("returns orange when any waiting", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeSessionDotStatus("s1", [layout], { "pty-1": makeEntry("waiting") }, new Set())).toBe("purple");
	});

	it("returns green when all idle and session opened", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeSessionDotStatus("s1", [layout], { "pty-1": makeEntry("idle") }, new Set(["s1"]))).toBe("green");
	});

	it("returns grey when all idle but session not opened", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeSessionDotStatus("s1", [layout], { "pty-1": makeEntry("idle") }, new Set())).toBe("grey");
	});

	it("error takes priority over active", () => {
		const layout: PaneNode = {
			type: "split", id: "s", direction: "horizontal", ratio: 0.5,
			first: { type: "terminal", id: "p1", ptyId: "pty-1" },
			second: { type: "terminal", id: "p2", ptyId: "pty-2" },
		};
		expect(computeSessionDotStatus("s1", [layout], {
			"pty-1": makeEntry("error"),
			"pty-2": makeEntry("active"),
		}, new Set())).toBe("red");
	});
});

describe("computeTabDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
	});

	const makeTab = (layoutJson: string): Tab => ({
		id: "t1",
		sessionId: "s1",
		name: "Tab 1",
		layoutJson,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	});

	it("returns green for invalid JSON", () => {
		expect(computeTabDotStatus(makeTab("invalid"), {})).toBe("green");
	});

	it("returns blue when active", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeTabDotStatus(makeTab(JSON.stringify(layout)), { "pty-1": makeEntry("active") })).toBe("amber");
	});

	it("returns green when all idle", () => {
		const layout: PaneNode = { type: "terminal", id: "p1", ptyId: "pty-1" };
		expect(computeTabDotStatus(makeTab(JSON.stringify(layout)), { "pty-1": makeEntry("idle") })).toBe("green");
	});
});

describe("computePtyDotStatus", () => {
	const makeEntry = (state: string): PtyActivityEntry => ({
		state: state as PtyActivityEntry["state"],
		lastOutputAt: 0,
		hasEverReceivedOutput: true,
	});

	it("returns green for unknown ptyId", () => {
		expect(computePtyDotStatus("unknown", {})).toBe("green");
	});

	it("returns blue for active", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("active") })).toBe("amber");
	});

	it("returns orange for waiting", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("waiting") })).toBe("purple");
	});

	it("returns red for error", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("error") })).toBe("red");
	});

	it("returns green for idle", () => {
		expect(computePtyDotStatus("pty-1", { "pty-1": makeEntry("idle") })).toBe("green");
	});
});

describe("shouldPulse", () => {
	it("returns true for amber, red", () => {
		expect(shouldPulse("amber")).toBe(true);
		expect(shouldPulse("red")).toBe(true);
	});

	it("returns false for grey, green, purple, null", () => {
		expect(shouldPulse("grey")).toBe(false);
		expect(shouldPulse("green")).toBe(false);
		expect(shouldPulse("purple")).toBe(false);
		expect(shouldPulse(null)).toBe(false);
	});
});

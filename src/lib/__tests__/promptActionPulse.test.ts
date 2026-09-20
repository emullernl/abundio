import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PulseEvent, pulse, subscribePulse } from "../promptActionPulse";

describe("promptActionPulse", () => {
	let seen: { actionId: string; nonce: number }[];
	let cleanups: (() => void)[];

	beforeEach(() => {
		seen = [];
		cleanups = [];
	});

	// The registry is a module-level map, so a listener left behind keeps
	// receiving every later pulse and corrupts the next test.
	afterEach(() => {
		for (const off of cleanups) off();
	});

	function listen(paneId: string, fn: (e: PulseEvent) => void) {
		cleanups.push(subscribePulse(paneId, fn));
	}

	it("delivers a send to the pane that is listening", () => {
		listen("pane-1", (e) => seen.push(e));
		pulse("pane-1", "action-a");
		expect(seen).toHaveLength(1);
		expect(seen[0].actionId).toBe("action-a");
	});

	it("does not leak a send to another pane's bar", () => {
		listen("pane-1", (e) => seen.push(e));
		pulse("pane-2", "action-a");
		expect(seen).toHaveLength(0);
	});

	it("gives consecutive sends of the same action distinct nonces", () => {
		// Without this a second send of the same button is indistinguishable from
		// the first, and an animation keyed on the id alone never replays.
		listen("pane-1", (e) => seen.push(e));
		pulse("pane-1", "action-a");
		pulse("pane-1", "action-a");
		expect(seen).toHaveLength(2);
		expect(seen[0].nonce).not.toBe(seen[1].nonce);
	});

	it("stops delivering once unsubscribed", () => {
		const off = subscribePulse("pane-1", (e) => seen.push(e));
		off();
		pulse("pane-1", "action-a");
		expect(seen).toHaveLength(0);
	});

	it("is harmless with nothing listening", () => {
		// The normal case for a pane whose bar is switched off.
		expect(() => pulse("pane-nobody", "action-a")).not.toThrow();
	});

	it("reaches every listener on the same pane", () => {
		const a = vi.fn();
		const b = vi.fn();
		listen("pane-1", a);
		listen("pane-1", b);
		pulse("pane-1", "action-a");
		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
	});
});

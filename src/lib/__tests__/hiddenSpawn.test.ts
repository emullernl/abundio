import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HIDDEN_SPAWN_DELAY_MS,
	HIDDEN_SPAWN_LIMIT_MS,
	startUnlessShown,
} from "../hiddenSpawn";

function fakePane() {
	const pane = {
		exists: false,
		started: false,
		starts: 0,
		listeners: new Set<() => void>(),
		create() {
			pane.exists = true;
			for (const l of pane.listeners) l();
		},
		deps() {
			return {
				exists: () => pane.exists,
				started: () => pane.started,
				start: () => {
					pane.starts++;
					pane.started = true;
				},
				subscribe: (l: () => void) => {
					pane.listeners.add(l);
					return () => pane.listeners.delete(l);
				},
			};
		},
	};
	return pane;
}

describe("startUnlessShown", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts a pane nothing shows, once its terminal exists", () => {
		const pane = fakePane();
		startUnlessShown(pane.deps());
		vi.advanceTimersByTime(5_000);
		expect(pane.starts).toBe(0);
		pane.create();
		vi.advanceTimersByTime(HIDDEN_SPAWN_DELAY_MS - 1);
		expect(pane.starts).toBe(0);
		vi.advanceTimersByTime(1);
		expect(pane.starts).toBe(1);
		expect(pane.listeners.size).toBe(0);
	});

	it("leaves a pane that was shown (and so started) alone", () => {
		const pane = fakePane();
		pane.exists = true;
		startUnlessShown(pane.deps());
		pane.started = true;
		vi.advanceTimersByTime(HIDDEN_SPAWN_DELAY_MS);
		expect(pane.starts).toBe(0);
	});

	it("arms once, however often the terminal changes", () => {
		const pane = fakePane();
		startUnlessShown(pane.deps());
		pane.create();
		pane.create();
		vi.advanceTimersByTime(HIDDEN_SPAWN_DELAY_MS * 3);
		expect(pane.starts).toBe(1);
	});

	it("gives up when the terminal never appears", () => {
		const pane = fakePane();
		startUnlessShown(pane.deps());
		vi.advanceTimersByTime(HIDDEN_SPAWN_LIMIT_MS);
		expect(pane.listeners.size).toBe(0);
		pane.create();
		vi.advanceTimersByTime(HIDDEN_SPAWN_DELAY_MS);
		expect(pane.starts).toBe(0);
	});

	it("does nothing once cancelled", () => {
		const pane = fakePane();
		pane.exists = true;
		const cancel = startUnlessShown(pane.deps());
		cancel();
		vi.advanceTimersByTime(HIDDEN_SPAWN_DELAY_MS);
		expect(pane.starts).toBe(0);
	});
});

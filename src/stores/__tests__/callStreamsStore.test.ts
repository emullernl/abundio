import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, MIN_VISIBLE_MS } from "../../lib/callStreams";
import {
	pulseControlActivity,
	startControlActivity,
} from "../../lib/controlActivity";
import {
	PULSE_MS,
	selectReceiving,
	useCallStreamsStore,
} from "../callStreamsStore";

const receiving = (paneId: string) =>
	selectReceiving(paneId)(useCallStreamsStore.getState());

describe("callStreamsStore", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	it("draws a call from its start until its minimum time and fade are over", () => {
		const end = startControlActivity({
			callerPaneId: "a",
			targetPaneId: "b",
			kind: "read",
		});
		expect(useCallStreamsStore.getState().streams.size).toBe(1);
		expect(receiving("b")).toBe(true);
		vi.advanceTimersByTime(5);
		end();
		expect(receiving("b")).toBe(true);
		vi.advanceTimersByTime(MIN_VISIBLE_MS);
		expect(receiving("b")).toBe(false);
		expect(useCallStreamsStore.getState().streams.size).toBe(1);
		vi.advanceTimersByTime(FADE_MS);
		expect(useCallStreamsStore.getState().streams.size).toBe(0);
	});

	it("leaves the streams alone for a call that changes nothing", () => {
		const before = useCallStreamsStore.getState().streams;
		startControlActivity({ callerPaneId: "a", targetPaneId: "a", kind: "act" });
		expect(useCallStreamsStore.getState().streams).toBe(before);
	});

	it("pulses a pane for a call that touched no other pane", () => {
		pulseControlActivity("p");
		expect(receiving("p")).toBe(true);
		vi.advanceTimersByTime(PULSE_MS);
		expect(receiving("p")).toBe(false);
	});

	it("is never receiving for no pane", () => {
		expect(selectReceiving(null)(useCallStreamsStore.getState())).toBe(false);
	});
});

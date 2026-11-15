import { describe, expect, it } from "vitest";
import {
	advanceStreams,
	FADE_MS,
	isReceiving,
	MIN_VISIBLE_MS,
	NO_STREAMS,
	nextStreamChange,
	reconcileStreams,
	streamEnded,
	streamStarted,
} from "../callStreams";
import type { ControlActivity } from "../controlActivity";

const call = (id: number, target = "b", startedAt = 0): ControlActivity => ({
	id,
	callerPaneId: "a",
	targetPaneId: target,
	kind: "read",
	startedAt,
});

describe("callStreams", () => {
	it("keeps a quick call on screen for the minimum time, then fades it", () => {
		let s = streamStarted(NO_STREAMS, call(1));
		s = streamEnded(s, 1, 5);
		// Ended after 5 ms, still lit.
		expect(advanceStreams(s, 5)).toBe(s);
		expect(isReceiving(s, "b")).toBe(true);
		expect(nextStreamChange(s, 5)).toBe(MIN_VISIBLE_MS);

		s = advanceStreams(s, MIN_VISIBLE_MS);
		expect(s.get(1)?.fading).toBe(true);
		expect(isReceiving(s, "b")).toBe(false);
		expect(nextStreamChange(s, MIN_VISIBLE_MS)).toBe(MIN_VISIBLE_MS + FADE_MS);

		s = advanceStreams(s, MIN_VISIBLE_MS + FADE_MS);
		expect(s.size).toBe(0);
		expect(nextStreamChange(s, 0)).toBeNull();
	});

	it("fades a long call as soon as it ends", () => {
		let s = streamStarted(NO_STREAMS, call(1));
		expect(nextStreamChange(s, 5000)).toBeNull();
		s = streamEnded(s, 1, 5000);
		s = advanceStreams(s, 5000);
		expect(s.get(1)?.fading).toBe(true);
	});

	it("ends a stream whose call stopped running without an end heard", () => {
		const s = streamStarted(streamStarted(NO_STREAMS, call(1)), call(2, "c"));
		const r = reconcileStreams(s, new Set([2]), 100);
		expect(r.get(1)?.endedAt).toBe(100);
		expect(r.get(2)?.endedAt).toBeNull();
		// Nothing to change: the same map back.
		expect(reconcileStreams(r, new Set([2]), 200)).toBe(r);
	});

	it("returns the same map when nothing changes", () => {
		const s = streamStarted(NO_STREAMS, call(1));
		expect(streamStarted(s, call(1))).toBe(s);
		expect(streamEnded(s, 99, 0)).toBe(s);
		const e = streamEnded(s, 1, 10);
		expect(streamEnded(e, 1, 20)).toBe(e);
		expect(advanceStreams(s, 10_000)).toBe(s);
	});
});

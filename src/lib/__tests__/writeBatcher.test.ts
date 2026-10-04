import { describe, expect, it } from "vitest";
import { createWriteBatcher, type WriteScheduler } from "../writeBatcher";

/** A scheduler whose frames and timers run only when the test says so. */
function manualScheduler() {
	let next = 1;
	const frames = new Map<number, () => void>();
	const timers = new Map<number, () => void>();
	const scheduler: WriteScheduler = {
		requestFrame: (cb) => {
			const id = next++;
			frames.set(id, cb);
			return id;
		},
		cancelFrame: (id) => {
			frames.delete(id);
		},
		setTimer: (cb) => {
			const id = next++;
			timers.set(id, cb);
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (id) => {
			timers.delete(id as unknown as number);
		},
	};
	const runAll = (m: Map<number, () => void>) => {
		const cbs = [...m.values()];
		m.clear();
		for (const cb of cbs) cb();
	};
	return {
		scheduler,
		frames,
		timers,
		runFrames: () => runAll(frames),
		runTimers: () => runAll(timers),
	};
}

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("createWriteBatcher", () => {
	it("merges chunks queued before a frame into one write", () => {
		const s = manualScheduler();
		const writes: Uint8Array[] = [];
		const b = createWriteBatcher((d) => writes.push(d), s.scheduler);
		b.push(bytes(1, 2));
		b.push(bytes(3));
		expect(writes).toEqual([]);
		s.runFrames();
		expect(writes).toEqual([bytes(1, 2, 3)]);
		expect(b.isEmpty()).toBe(true);
	});

	it("drains on the timer when no frame ever comes (hidden window)", () => {
		const s = manualScheduler();
		const writes: Uint8Array[] = [];
		const b = createWriteBatcher((d) => writes.push(d), s.scheduler);
		b.push(bytes(1));
		s.runTimers();
		expect(writes).toEqual([bytes(1)]);
		// The frame that was racing it is cancelled, not left to fire later.
		expect(s.frames.size).toBe(0);
	});

	it("cancels the timer when the frame wins", () => {
		const s = manualScheduler();
		const b = createWriteBatcher(() => {}, s.scheduler);
		b.push(bytes(1));
		s.runFrames();
		expect(s.timers.size).toBe(0);
	});

	it("schedules one frame and one timer per batch", () => {
		const s = manualScheduler();
		const b = createWriteBatcher(() => {}, s.scheduler);
		for (let i = 0; i < 50; i++) b.push(bytes(i));
		expect(s.frames.size).toBe(1);
		expect(s.timers.size).toBe(1);
	});

	it("writes at once when the queue reaches maxBytes", () => {
		const s = manualScheduler();
		const writes: Uint8Array[] = [];
		const b = createWriteBatcher((d) => writes.push(d), s.scheduler, {
			maxBytes: 4,
		});
		b.push(bytes(1, 2));
		expect(writes).toEqual([]);
		b.push(bytes(3, 4));
		expect(writes).toEqual([bytes(1, 2, 3, 4)]);
		expect(s.frames.size).toBe(0);
		expect(s.timers.size).toBe(0);
	});

	it("flush writes what is queued and is a no-op when empty", () => {
		const s = manualScheduler();
		const writes: Uint8Array[] = [];
		const b = createWriteBatcher((d) => writes.push(d), s.scheduler);
		b.flush();
		expect(writes).toEqual([]);
		b.push(bytes(7));
		b.flush();
		expect(writes).toEqual([bytes(7)]);
		expect(s.frames.size).toBe(0);
		expect(s.timers.size).toBe(0);
	});
});

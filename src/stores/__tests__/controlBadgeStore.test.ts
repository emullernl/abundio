import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BADGE_MIN_VISIBLE_MS,
	useControlBadgeStore,
} from "../controlBadgeStore";

beforeEach(() => {
	vi.useFakeTimers();
	useControlBadgeStore.setState({ badges: {} });
});
afterEach(() => vi.useRealTimers());

const badge = () => useControlBadgeStore.getState().badges.b;

describe("controlBadgeStore", () => {
	it("shows a badge while a call runs and clears it after", () => {
		const end = useControlBadgeStore.getState().begin("b", "p1");
		expect(badge()).toEqual({ by: "p1", count: 1 });
		vi.advanceTimersByTime(BADGE_MIN_VISIBLE_MS);
		end();
		expect(badge()).toBeUndefined();
	});

	it("keeps a quick call's badge up long enough to be seen", () => {
		const end = useControlBadgeStore.getState().begin("b", "p1");
		end();
		expect(badge()).toEqual({ by: "p1", count: 1 });
		vi.advanceTimersByTime(BADGE_MIN_VISIBLE_MS - 1);
		expect(badge()).toBeDefined();
		vi.advanceTimersByTime(1);
		expect(badge()).toBeUndefined();
	});

	it("stays until the last of several calls ends, naming the latest caller", () => {
		const s = useControlBadgeStore.getState();
		const end1 = s.begin("b", "p1");
		const end2 = s.begin("b", "rev");
		expect(badge()?.by).toBe("rev");
		vi.advanceTimersByTime(BADGE_MIN_VISIBLE_MS);
		end1();
		end1();
		expect(badge()).toEqual({ by: "rev", count: 1 });
		end2();
		expect(badge()).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	MIN_PR_LIST_PX,
	PR_SPLIT_DIVIDER_PX,
	prListsHeight,
	prReviewShare,
	reviewShareFromDrag,
} from "../prSplit";

describe("prReviewShare", () => {
	it("keeps a share inside the limits", () => {
		expect(prReviewShare(0.5, 600)).toBe(0.5);
		expect(prReviewShare(0.3, 600)).toBe(0.3);
	});

	it("keeps each list at least MIN_PR_LIST_PX tall", () => {
		const h = 400;
		expect(prReviewShare(0, h)).toBeCloseTo(MIN_PR_LIST_PX / h);
		expect(prReviewShare(1, h)).toBeCloseTo(1 - MIN_PR_LIST_PX / h);
	});

	it.each([
		150, 200, 300, 800, 1600,
	])("never leaves a list under the minimum at %ipx", (h) => {
		for (const share of [0, 0.05, 0.5, 0.95, 1]) {
			const s = prReviewShare(share, h);
			expect(s * h).toBeGreaterThanOrEqual(MIN_PR_LIST_PX - 1e-9);
			expect((1 - s) * h).toBeGreaterThanOrEqual(MIN_PR_LIST_PX - 1e-9);
		}
	});

	it("falls back to half and half when too short for both minimums", () => {
		expect(prReviewShare(0.9, 2 * MIN_PR_LIST_PX - 1)).toBe(0.5);
		expect(prReviewShare(0.1, 60)).toBe(0.5);
	});

	it("draws a saved extreme share with both headers in a short container", () => {
		const s = prReviewShare(0.95, 180);
		expect((1 - s) * 180).toBeCloseTo(MIN_PR_LIST_PX);
	});

	it("only clamps to 0..1 before the container is measured", () => {
		expect(prReviewShare(0.9, 0)).toBe(0.9);
		expect(prReviewShare(1.5, 0)).toBe(1);
	});

	it("uses the default for a non-number share", () => {
		expect(prReviewShare(Number.NaN, 600)).toBe(0.5);
		expect(prReviewShare(Number.POSITIVE_INFINITY, 600)).toBe(0.5);
	});
});

describe("prListsHeight", () => {
	it("takes the divider out of a measured height", () => {
		expect(prListsHeight(300)).toBe(300 - PR_SPLIT_DIVIDER_PX);
		expect(prListsHeight(0)).toBe(0);
	});
});

describe("reviewShareFromDrag", () => {
	it("puts the divider's middle under the pointer", () => {
		const h = 604;
		const share = reviewShareFromDrag(0.5, h);
		const room = h - PR_SPLIT_DIVIDER_PX;
		// Review list ends, then half the divider: the pointer's y.
		expect((share ?? 0) * room + PR_SPLIT_DIVIDER_PX / 2).toBeCloseTo(302);
	});

	it("stops at the minimums past the top and bottom", () => {
		const room = 600 - PR_SPLIT_DIVIDER_PX;
		expect((reviewShareFromDrag(0, 600) ?? 0) * room).toBeCloseTo(
			MIN_PR_LIST_PX,
		);
		expect((1 - (reviewShareFromDrag(1, 600) ?? 0)) * room).toBeCloseTo(
			MIN_PR_LIST_PX,
		);
	});

	it("leaves the split alone when too short or unmeasured", () => {
		expect(reviewShareFromDrag(0.8, 2 * MIN_PR_LIST_PX)).toBeNull();
		expect(reviewShareFromDrag(0.8, 0)).toBeNull();
		expect(reviewShareFromDrag(Number.NaN, 600)).toBeNull();
	});
});

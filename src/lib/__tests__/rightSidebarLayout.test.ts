import { describe, expect, it } from "vitest";
import {
	commitsShareFromDrag,
	MIN_SHARE,
	prRatioFromDrag,
	rightSidebarShares,
} from "../rightSidebarLayout";

const open = { commitsCollapsed: false, prCollapsed: false };

describe("rightSidebarShares", () => {
	it("carves the commits out of the tab content, leaving the PR height alone", () => {
		// A pre-upgrade user: prRatio 0.6 meant tab 60% / PR 40%.
		const s = rightSidebarShares({ prRatio: 0.6, commitsShare: 0.2, ...open });
		expect(s.pr).toBeCloseTo(0.4);
		expect(s.commits).toBeCloseTo(0.2);
		expect(s.tab).toBeCloseTo(0.4);
	});

	it("gives a collapsed section's height to the tab content", () => {
		const c = rightSidebarShares({
			prRatio: 0.6,
			commitsShare: 0.2,
			commitsCollapsed: true,
			prCollapsed: false,
		});
		expect([c.tab, c.commits]).toEqual([0.6, 0]);
		const p = rightSidebarShares({
			prRatio: 0.6,
			commitsShare: 0.2,
			commitsCollapsed: false,
			prCollapsed: true,
		});
		expect(p.pr).toBe(0);
		expect(p.commits).toBeCloseTo(0.2);
		expect(p.tab).toBeCloseTo(0.8);
	});

	it("never squeezes the tab content below the floor", () => {
		const s = rightSidebarShares({ prRatio: 0.2, commitsShare: 0.3, ...open });
		expect(s.tab).toBeGreaterThanOrEqual(MIN_SHARE - 1e-9);
		expect(s.commits).toBeGreaterThanOrEqual(MIN_SHARE - 1e-9);
	});
});

describe("drags", () => {
	it("the commits divider sets where the tab content ends", () => {
		// PR takes the bottom 40%; tab ends at 35% → commits 25%.
		expect(commitsShareFromDrag(0.35, 0.4)).toBeCloseTo(0.25);
		// With PRs collapsed the commits reach the bottom.
		expect(commitsShareFromDrag(0.35, 0)).toBeCloseTo(0.65);
		// Clamped at both ends.
		expect(commitsShareFromDrag(0.59, 0.4)).toBe(MIN_SHARE);
		expect(commitsShareFromDrag(0, 0.4)).toBeCloseTo(0.5);
	});

	it("the PR divider cannot push into the commits' height", () => {
		expect(prRatioFromDrag(0.7, 0.2)).toBe(0.7);
		expect(prRatioFromDrag(0.1, 0.2)).toBeCloseTo(0.3);
		expect(prRatioFromDrag(0.99, 0.2)).toBeCloseTo(0.9);
	});
});

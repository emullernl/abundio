import { describe, expect, it } from "vitest";
import {
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_PANES_MIN,
	ORCHESTRATOR_TAB_STRIP,
	panesTop,
	ratioFor,
	topContentHeight,
} from "../orchestratorLayout";

describe("orchestratorLayout", () => {
	const room = (view: number) =>
		view - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER;

	it("splits the room by the ratio, half by default", () => {
		expect(topContentHeight(0.5, false, 1000)).toBe(Math.round(room(1000) / 2));
		expect(topContentHeight(0.25, false, 1000)).toBe(
			Math.round(room(1000) / 4),
		);
	});
	it("shrinks the top so the panes keep their minimum", () => {
		const view = 400;
		const h = topContentHeight(0.9, false, view);
		expect(room(view) - h).toBe(ORCHESTRATOR_PANES_MIN);
	});
	it("is zero when collapsed or not measured yet, and never negative", () => {
		expect(topContentHeight(0.5, true, 1000)).toBe(0);
		expect(topContentHeight(0.5, false, 0)).toBe(0);
		expect(topContentHeight(0.5, false, 100)).toBe(0);
	});
	it("turns a dragged height back into the ratio", () => {
		const h = topContentHeight(0.4, false, 900);
		expect(ratioFor(h, 900)).toBeCloseTo(0.4, 2);
	});
	it("puts the panes under the strip, the content and the divider", () => {
		expect(panesTop(100)).toBe(
			ORCHESTRATOR_TAB_STRIP + 100 + ORCHESTRATOR_DIVIDER,
		);
	});
});

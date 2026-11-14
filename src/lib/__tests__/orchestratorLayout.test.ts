import { describe, expect, it } from "vitest";
import {
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_PANES_MIN,
	ORCHESTRATOR_TAB_STRIP,
	panesTop,
	topContentHeight,
} from "../orchestratorLayout";

describe("orchestratorLayout", () => {
	it("keeps the stored height when there is room", () => {
		expect(topContentHeight(280, false, 1000)).toBe(280);
	});
	it("shrinks the top so the panes keep their minimum", () => {
		const view = 500;
		const h = topContentHeight(400, false, view);
		expect(view - ORCHESTRATOR_TAB_STRIP - h - ORCHESTRATOR_DIVIDER).toBe(
			ORCHESTRATOR_PANES_MIN,
		);
	});
	it("is zero when collapsed, and never negative", () => {
		expect(topContentHeight(280, true, 1000)).toBe(0);
		expect(topContentHeight(280, false, 100)).toBe(0);
	});
	it("uses the stored height before the view is measured", () => {
		expect(topContentHeight(280, false, 0)).toBe(280);
	});
	it("puts the panes under the strip, the content and the divider", () => {
		expect(panesTop(100)).toBe(
			ORCHESTRATOR_TAB_STRIP + 100 + ORCHESTRATOR_DIVIDER,
		);
	});
});

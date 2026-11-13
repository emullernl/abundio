import { describe, expect, it } from "vitest";
import { scrollToShowTab, TAB_SCROLL_MARGIN } from "../tabStripScroll";

const strip = { viewWidth: 400, contentWidth: 1000 };

describe("scrollToShowTab", () => {
	it("leaves a Tab that is already in full view", () => {
		expect(
			scrollToShowTab({ ...strip, scrollLeft: 100, left: 150, right: 300 }),
		).toBeNull();
	});

	it("scrolls right just far enough, with a margin", () => {
		expect(
			scrollToShowTab({ ...strip, scrollLeft: 0, left: 600, right: 750 }),
		).toBe(750 - 400 + TAB_SCROLL_MARGIN);
	});

	it("scrolls left just far enough, with a margin", () => {
		expect(
			scrollToShowTab({ ...strip, scrollLeft: 500, left: 200, right: 350 }),
		).toBe(200 - TAB_SCROLL_MARGIN);
	});

	it("never scrolls past either end", () => {
		expect(
			scrollToShowTab({ ...strip, scrollLeft: 0, left: 850, right: 1000 }),
		).toBe(600);
		expect(
			scrollToShowTab({ ...strip, scrollLeft: 300, left: 0, right: 150 }),
		).toBe(0);
	});
});

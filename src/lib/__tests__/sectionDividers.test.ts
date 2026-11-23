import { describe, expect, it } from "vitest";
import { dividersBefore } from "../sectionDividers";

describe("dividersBefore", () => {
	it("divides only between sections that both show something", () => {
		expect(dividersBefore([true, true, true])).toEqual([false, true, true]);
		// An empty or folded section in between: still one divider, not two.
		expect(dividersBefore([true, false, true])).toEqual([false, false, true]);
		// Nothing shown above: no divider at the top.
		expect(dividersBefore([false, true, true])).toEqual([false, false, true]);
		expect(dividersBefore([false, false])).toEqual([false, false]);
	});
});

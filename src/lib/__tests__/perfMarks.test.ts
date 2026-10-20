import { afterEach, describe, expect, it, vi } from "vitest";
import { perfMark, perfMeasure } from "../perfMarks";

describe("perfMarks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records a measure from the given start with its detail", () => {
		const measure = vi
			.spyOn(performance, "measure")
			.mockImplementation(() => ({}) as PerformanceMeasure);
		perfMeasure("abundio:project", 5, "pane-1");
		expect(measure).toHaveBeenCalledWith(
			"abundio:project",
			expect.objectContaining({ start: 5, detail: "pane-1" }),
		);
	});

	it("clears each entry once recorded, so the buffer never grows", () => {
		perfMark("abundio:switch-tab");
		perfMeasure("abundio:project", performance.now());
		expect(performance.getEntriesByName("abundio:switch-tab")).toHaveLength(0);
		expect(performance.getEntriesByName("abundio:project")).toHaveLength(0);
	});

	it("never throws when the timing API refuses", () => {
		vi.spyOn(performance, "mark").mockImplementation(() => {
			throw new Error("unsupported");
		});
		vi.spyOn(performance, "measure").mockImplementation(() => {
			throw new Error("unsupported");
		});
		expect(() => perfMark("abundio:switch-tab")).not.toThrow();
		expect(() => perfMeasure("abundio:fit", 0)).not.toThrow();
	});
});

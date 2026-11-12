import { describe, expect, it } from "vitest";
import { crowdHint, MAX_PANES, MIN_COLS, MIN_ROWS } from "../crowding";

const roomy = { terminalPanes: 1, cols: 200, rows: 50 };

describe("crowdHint", () => {
	it("is quiet when both halves are roomy and the Tab is not busy", () => {
		expect(crowdHint({ ...roomy, direction: "right" })).toBeNull();
		expect(crowdHint({ ...roomy, direction: "down" })).toBeNull();
	});

	it("hints when a right split leaves halves under 60 columns", () => {
		// One column goes to the divider: 121 → 60 each, 120 → 59.
		expect(
			crowdHint({ ...roomy, cols: 2 * MIN_COLS + 1, direction: "right" }),
		).toBeNull();
		expect(
			crowdHint({ ...roomy, cols: 2 * MIN_COLS, direction: "right" }),
		).toContain("59 columns");
	});

	it("hints when a down split leaves halves under 12 rows", () => {
		expect(
			crowdHint({ ...roomy, rows: 2 * MIN_ROWS + 1, direction: "down" }),
		).toBeNull();
		expect(
			crowdHint({ ...roomy, rows: 2 * MIN_ROWS, direction: "down" }),
		).toContain("11 rows");
	});

	it("counts the side a split does not halve as it is", () => {
		// A down split keeps the full width; a right split the full height.
		expect(
			crowdHint({ ...roomy, cols: MIN_COLS - 1, direction: "down" }),
		).not.toBeNull();
		expect(
			crowdHint({ ...roomy, rows: MIN_ROWS - 1, direction: "right" }),
		).not.toBeNull();
	});

	it("hints in a busy Tab whatever its size", () => {
		expect(
			crowdHint({ ...roomy, terminalPanes: MAX_PANES - 1, direction: "right" }),
		).toBeNull();
		const hint = crowdHint({
			...roomy,
			terminalPanes: MAX_PANES,
			direction: "right",
		});
		expect(hint).toContain("already had 4 panes");
		expect(hint).toContain("--tab");
	});
});

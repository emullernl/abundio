import { describe, expect, it } from "vitest";
import { shouldRefocusAfterProjection } from "../projectionFocus";

const body = document.createElement("body");
const termEl = document.createElement("div");
const inside = document.createElement("textarea");
termEl.appendChild(inside);
const elsewhere = document.createElement("input");

const base = { isTarget: true, body, termEl };

describe("shouldRefocusAfterProjection", () => {
	it("takes focus back when the moves dropped it to <body>", () => {
		// The split case: the retract already lost focus, so at reveal time
		// the focused pane's terminal finds nothing focused.
		expect(shouldRefocusAfterProjection({ ...base, active: body })).toBe(true);
		expect(shouldRefocusAfterProjection({ ...base, active: null })).toBe(true);
		expect(shouldRefocusAfterProjection({ ...base, active: inside })).toBe(
			true,
		);
	});

	it("leaves a pane that is not the one keystrokes go to", () => {
		expect(
			shouldRefocusAfterProjection({ ...base, isTarget: false, active: body }),
		).toBe(false);
	});

	it("never takes focus from an input, editor or other terminal", () => {
		expect(shouldRefocusAfterProjection({ ...base, active: elsewhere })).toBe(
			false,
		);
	});
});

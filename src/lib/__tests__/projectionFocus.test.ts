import { describe, expect, it } from "vitest";
import { shouldRefocusAfterProjection } from "../projectionFocus";

const body = document.createElement("body");
const termEl = document.createElement("div");
const inside = document.createElement("textarea");
termEl.appendChild(inside);
const elsewhere = document.createElement("input");

const base = { hadFocus: true, stillTarget: true, body, termEl };

describe("shouldRefocusAfterProjection", () => {
	it("gives focus back when the move dropped it to <body>", () => {
		expect(shouldRefocusAfterProjection({ ...base, active: body })).toBe(true);
		expect(shouldRefocusAfterProjection({ ...base, active: null })).toBe(true);
		expect(shouldRefocusAfterProjection({ ...base, active: inside })).toBe(
			true,
		);
	});

	it("never takes focus it did not have", () => {
		expect(
			shouldRefocusAfterProjection({ ...base, hadFocus: false, active: body }),
		).toBe(false);
	});

	it("leaves it when another pane is now the target", () => {
		expect(
			shouldRefocusAfterProjection({
				...base,
				stillTarget: false,
				active: body,
			}),
		).toBe(false);
	});

	it("leaves it when something else took focus meanwhile", () => {
		expect(shouldRefocusAfterProjection({ ...base, active: elsewhere })).toBe(
			false,
		);
	});
});

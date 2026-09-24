import { describe, expect, it } from "vitest";
import { stagingOrder } from "../FleetConsole";

// The Console brings tiles in visible-first — see FleetConsole's staggered
// mount.
describe("stagingOrder", () => {
	const ids = ["a", "b", "c", "d", "e", "f", "g"];

	it("brings in what fits on screen first, then the rest in grid order", () => {
		expect(stagingOrder(ids, null, null, 4)).toEqual({
			first: ["a", "b", "c", "d"],
			rest: ["e", "f", "g"],
		});
	});

	it("puts the spotlighted and focused tiles first, wherever they are", () => {
		expect(stagingOrder(ids, "f", "g", 2)).toEqual({
			first: ["g", "f", "a", "b"],
			rest: ["c", "d", "e"],
		});
	});

	it("ignores a focused or spotlighted id that is not a tile", () => {
		expect(stagingOrder(ids, "gone", null, 1).first).toEqual(["a"]);
	});

	it("handles more room than tiles", () => {
		expect(stagingOrder(["a"], "a", null, 12)).toEqual({
			first: ["a"],
			rest: [],
		});
	});
});

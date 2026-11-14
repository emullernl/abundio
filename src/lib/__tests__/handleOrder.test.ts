import { describe, expect, it } from "vitest";
import {
	compareHandles,
	defaultHandleNumber,
	sortByHandle,
} from "../handleOrder";

describe("defaultHandleNumber", () => {
	it("reads Default handles as Rust spells them", () => {
		expect(defaultHandleNumber("Agent One")).toBe(1);
		expect(defaultHandleNumber("Agent Ten")).toBe(10);
		expect(defaultHandleNumber("Agent Twenty-One")).toBe(21);
		expect(defaultHandleNumber("Agent One Hundred Five")).toBe(105);
		expect(defaultHandleNumber("Agent Three Hundred")).toBe(300);
	});

	it("ignores case and treats spaces and dashes alike", () => {
		expect(defaultHandleNumber("agent twenty one")).toBe(21);
		expect(defaultHandleNumber("AGENT-TWO")).toBe(2);
	});

	it("is null for any other handle", () => {
		expect(defaultHandleNumber("Agent Smith")).toBeNull();
		expect(defaultHandleNumber("Agent Zero")).toBeNull();
		expect(defaultHandleNumber("Reviewer")).toBeNull();
		expect(defaultHandleNumber("Agent 2")).toBeNull();
	});
});

describe("compareHandles / sortByHandle", () => {
	const sort = (handles: (string | undefined)[]) =>
		sortByHandle(handles, (h) => h);

	it("sorts Default handles by number, not by letters", () => {
		expect(
			sort(["Agent Ten", "Agent Two", "Agent Eight", "Agent One"]),
		).toEqual(["Agent One", "Agent Two", "Agent Eight", "Agent Ten"]);
	});

	it("places Default handles where 'Agent' falls among the others", () => {
		expect(
			sort([
				"zeta",
				"Agent Two",
				"Agent Smith",
				"Builder",
				"aardvark",
				"Agent One",
			]),
		).toEqual([
			"aardvark",
			"Agent One",
			"Agent Two",
			"Agent Smith",
			"Builder",
			"zeta",
		]);
	});

	it("ignores case and orders digits by value", () => {
		expect(sort(["bob", "Alice", "Worker 10", "worker 2"])).toEqual([
			"Alice",
			"bob",
			"worker 2",
			"Worker 10",
		]);
	});

	it("puts a custom handle 'Agent' before the Default handles", () => {
		expect(compareHandles("Agent", "Agent One")).toBeLessThan(0);
		expect(compareHandles("Agent One", "Agent")).toBeGreaterThan(0);
	});

	it("puts panes without a handle last, keeping their order", () => {
		const items = [
			{ id: "a" },
			{ id: "b", h: "Zed" },
			{ id: "c" },
			{ id: "d", h: "Amy" },
		];
		expect(sortByHandle(items, (i) => i.h).map((i) => i.id)).toEqual([
			"d",
			"b",
			"a",
			"c",
		]);
	});
});

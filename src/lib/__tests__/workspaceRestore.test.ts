import { describe, expect, it } from "vitest";
import { pickActive } from "../workspaceRestore";

describe("pickActive", () => {
	it("keeps the remembered Active workspace when it came back", () => {
		expect(pickActive({ opened: ["a", "b"], active: "b" })).toBe("b");
	});

	it("falls back to the first restored one when it did not", () => {
		expect(pickActive({ opened: ["a", "b"], active: "x" })).toBe("a");
		expect(pickActive({ opened: ["a", "b"], active: null })).toBe("a");
	});

	it("is none when nothing was restored", () => {
		expect(pickActive({ opened: [], active: "a" })).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { nextTabName } from "../tabName";

describe("nextTabName", () => {
	it("starts at Tab 1", () => {
		expect(nextTabName([])).toBe("Tab 1");
	});

	it("takes the lowest free number", () => {
		expect(nextTabName(["Tab 1", "Tab 3"])).toBe("Tab 2");
		expect(nextTabName(["Tab 2"])).toBe("Tab 1");
		expect(nextTabName(["Tab 1", "Tab 2"])).toBe("Tab 3");
	});

	it("ignores older Terminal N names", () => {
		expect(nextTabName(["Terminal 1", "Terminal 2"])).toBe("Tab 1");
	});

	it("counts a Tab the user renamed to Tab N", () => {
		expect(nextTabName(["Tab 1", "server", "Tab 2"])).toBe("Tab 3");
	});

	it("matches the exact spelling only", () => {
		expect(nextTabName(["tab 1", "Tab 1b", "Tab  1", "Tab 01", " Tab 1"])).toBe(
			"Tab 1",
		);
	});
});

import { describe, expect, it } from "vitest";
import { cycleOpenedWorkspace } from "../workspaceCycle";

describe("cycleOpenedWorkspace", () => {
	const order = ["a", "b", "c", "d", "e"];

	it("skips Workspaces that are not Opened", () => {
		const opened = new Set(["a", "c", "e"]);
		expect(cycleOpenedWorkspace(order, opened, "a", 1)).toBe("c");
		expect(cycleOpenedWorkspace(order, opened, "c", 1)).toBe("e");
		expect(cycleOpenedWorkspace(order, opened, "e", -1)).toBe("c");
	});

	it("follows sidebar order, not the order Workspaces were opened", () => {
		const opened = new Set(["e", "b", "a"]);
		expect(cycleOpenedWorkspace(order, opened, "a", 1)).toBe("b");
		expect(cycleOpenedWorkspace(order, opened, "b", 1)).toBe("e");
	});

	it("wraps at both ends", () => {
		const opened = new Set(["b", "d"]);
		expect(cycleOpenedWorkspace(order, opened, "d", 1)).toBe("b");
		expect(cycleOpenedWorkspace(order, opened, "b", -1)).toBe("d");
	});

	it("treats the Active workspace as Opened", () => {
		expect(cycleOpenedWorkspace(order, new Set(["d"]), "b", 1)).toBe("d");
		expect(cycleOpenedWorkspace(order, new Set(["d"]), "d", 1)).toBeNull();
	});

	it("does nothing with a single Opened workspace", () => {
		expect(cycleOpenedWorkspace(order, new Set(["c"]), "c", 1)).toBeNull();
		expect(cycleOpenedWorkspace(order, new Set(["c"]), "c", -1)).toBeNull();
	});

	it("enters the ring at the matching end when nothing is active", () => {
		const opened = new Set(["b", "d"]);
		expect(cycleOpenedWorkspace(order, opened, null, 1)).toBe("b");
		expect(cycleOpenedWorkspace(order, opened, null, -1)).toBe("d");
		expect(cycleOpenedWorkspace(order, new Set(), null, 1)).toBeNull();
	});
});

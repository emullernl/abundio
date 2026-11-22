import { describe, expect, it } from "vitest";
import { panesEndedBy, restartMessage } from "../hostSetup";
import type { HostCheck } from "../ipc";

const check = (running: boolean, panes: number | null): HostCheck => ({
	probe: {
		os: "Linux",
		arch: "x86_64",
		user: "dev",
		current: "3.0.0",
		installed: ["3.0.0"],
		running,
		panes,
		agents: [],
	},
	items: [],
	appVersion: "3.1.0",
});

describe("panesEndedBy", () => {
	it("counts the panes a restart would end", () => {
		expect(panesEndedBy("update", check(true, 3))).toBe(3);
		expect(panesEndedBy("service", check(true, 1))).toBe(1);
		expect(panesEndedBy("install", check(true, 2))).toBe(2);
	});
	it("asks nothing when nothing would end", () => {
		expect(panesEndedBy("start", check(true, 3))).toBe(0);
		expect(panesEndedBy("update", check(false, 3))).toBe(0);
		expect(panesEndedBy("update", check(true, null))).toBe(0);
	});
});

describe("restartMessage", () => {
	it("says what ends and on which Host", () => {
		expect(restartMessage("update", "box", 1)).toMatch(
			/^1 pane is running on box\. Updating restarts/,
		);
		expect(restartMessage("service", "box", 2)).toContain("2 panes are");
	});
});

describe("removing the service (all platforms)", () => {
	it("asks first when panes would end, like the other restarts", () => {
		const last = {
			probe: { running: true, panes: 2 },
		} as unknown as import("../ipc").HostCheck;
		expect(panesEndedBy("unservice", last)).toBe(2);
		expect(restartMessage("unservice", "box", 2)).toContain(
			"Removing the service restarts the server without it",
		);
	});
});

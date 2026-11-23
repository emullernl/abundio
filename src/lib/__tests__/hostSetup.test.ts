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

import { checkedAgo, hostSummary, problemItems } from "../hostSetup";

describe("hostSummary (Settings ▸ Hosts' status line)", () => {
	const check = (states: string[]) =>
		({
			probe: {
				os: "Linux",
				arch: "x86_64",
				current: "3.1.0",
				running: true,
				panes: 0,
			},
			items: states.map((state, i) => ({
				id: `i${i}`,
				label: `Line ${i}`,
				state,
				fix: null,
				action: null,
			})),
			appVersion: "3.1.0",
		}) as unknown as import("../ipc").HostCheck;

	it("says Ready, with the server and platform, when nothing needs doing", () => {
		expect(hostSummary(check(["ok", "info"]), null)).toEqual({
			tone: "ok",
			state: "Ready",
			detail: "Server 3.1.0 on Linux x86_64.",
		});
	});

	it("names the first problem, and how many more, at its worst tone", () => {
		const s = hostSummary(check(["ok", "warn", "error"]), null);
		expect(s).toEqual({
			tone: "error",
			state: "Needs attention",
			detail: "Line 1, and 1 more.",
		});
		expect(problemItems(check(["ok", "warn"]).items).map((i) => i.id)).toEqual([
			"i1",
		]);
	});

	it("shows what is running, and an unreachable Host's reason", () => {
		expect(hostSummary(check(["ok"]), "Uploading the server…").tone).toBe(
			"busy",
		);
		expect(hostSummary("checking", null).state).toBe("Checking…");
		expect(
			hostSummary({ error: "Channel error: Permission denied\nmore" }, null),
		).toEqual({
			tone: "error",
			state: "Can't reach it",
			detail: "Permission denied",
		});
		expect(hostSummary(undefined, null).tone).toBe("unknown");
	});

	it("says when it was checked", () => {
		const now = 1_000_000_000;
		expect(checkedAgo(now - 20_000, now)).toBe("Checked just now");
		expect(checkedAgo(now - 5 * 60_000, now)).toBe("Checked 5 min ago");
		expect(checkedAgo(now - 3 * 3_600_000, now)).toBe("Checked 3 h ago");
	});
});

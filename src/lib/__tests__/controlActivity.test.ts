import { describe, expect, it, vi } from "vitest";
import {
	controlKind,
	localCaller,
	runningControlActivity,
	startControlActivity,
	subscribeControlActivity,
} from "../controlActivity";

describe("controlActivity", () => {
	it("tells reads from acts", () => {
		expect(controlKind("pane.watch")).toBe("read");
		expect(controlKind("pane.split")).toBe("act");
		expect(controlKind("pane.close")).toBe("act");
	});

	it("reports a call's start and end, once each, and what runs now", () => {
		const seen = vi.fn();
		const stop = subscribeControlActivity(seen);
		const end = startControlActivity({
			callerPaneId: "a",
			targetPaneId: "b",
			kind: "act",
		});
		expect(runningControlActivity().map((c) => c.targetPaneId)).toEqual(["b"]);
		end();
		end();
		stop();
		expect(seen.mock.calls.map((c) => c[0].type)).toEqual(["start", "end"]);
		expect(runningControlActivity()).toEqual([]);
	});

	it("never draws a call a pane makes at itself", () => {
		const seen = vi.fn();
		const stop = subscribeControlActivity(seen);
		startControlActivity({
			callerPaneId: "a",
			targetPaneId: "a",
			kind: "read",
		})();
		stop();
		expect(seen).not.toHaveBeenCalled();
	});
});

describe("localCaller (ADR-0065)", () => {
	it("maps a Host's name for one of this Window's Agents back to its pane", () => {
		expect(localCaller("outside:window-1:pane-9", "window-1")).toBe("pane-9");
		// Another Window's Agent, or a Host's own pane, stays as it is.
		expect(localCaller("outside:window-2:pane-9", "window-1")).toBe(
			"outside:window-2:pane-9",
		);
		expect(localCaller("pane-3", "window-1")).toBe("pane-3");
	});
});

import { describe, expect, it, vi } from "vitest";
import {
	controlKind,
	runningControlActivity,
	startControlActivity,
	subscribeControlActivity,
} from "../controlActivity";

describe("controlActivity", () => {
	it("tells reads from acts", () => {
		expect(controlKind("pane.read")).toBe("read");
		expect(controlKind("agent.wait")).toBe("read");
		expect(controlKind("agent.prompt")).toBe("act");
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

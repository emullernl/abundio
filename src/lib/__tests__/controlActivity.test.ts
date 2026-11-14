import { describe, expect, it, vi } from "vitest";
import {
	controlKind,
	publishControlActivity,
	subscribeControlActivity,
} from "../controlActivity";

describe("controlActivity", () => {
	it("tells reads from acts", () => {
		expect(controlKind("pane.read")).toBe("read");
		expect(controlKind("agent.wait")).toBe("read");
		expect(controlKind("agent.prompt")).toBe("act");
		expect(controlKind("pane.close")).toBe("act");
	});

	it("delivers a call to subscribers, never one aimed at the caller itself", () => {
		const seen = vi.fn();
		const stop = subscribeControlActivity(seen);
		publishControlActivity({
			callerPaneId: "a",
			targetPaneId: "b",
			kind: "act",
		});
		publishControlActivity({
			callerPaneId: "a",
			targetPaneId: "a",
			kind: "read",
		});
		stop();
		publishControlActivity({
			callerPaneId: "a",
			targetPaneId: "c",
			kind: "act",
		});
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0][0]).toMatchObject({ targetPaneId: "b" });
	});
});

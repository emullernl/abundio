import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));

import { __captureStatusOpsForTests } from "../../lib/statusSync";
import { usePtyActivityStore } from "../ptyActivityStore";

describe("an Agent Rust found by its hook", () => {
	it("is recorded for the PTY without touching its status", () => {
		const s = usePtyActivityStore.getState();
		s.initPty("h", "shell");
		const before = usePtyActivityStore.getState().activities.h;
		s.noteAgentFromHost("h", "claude");
		const after = usePtyActivityStore.getState();
		expect(after.agentPtyIds.has("h")).toBe(true);
		expect(after.detectedAgentIds.h).toBe("claude");
		// Rust applied the status half; its update follows on its own.
		expect(after.activities.h).toBe(before);
	});
});

describe("which Agent a PTY runs", () => {
	it("is sent to Rust whenever it changes, for its Title status", () => {
		const ops: unknown[] = [];
		__captureStatusOpsForTests((op) => {
			if (op.op === "agent") ops.push(op);
		});
		try {
			const s = usePtyActivityStore.getState();
			s.initPty("v", "shell");
			s.setAgentPty("v", "vibe");
			s.noteAgentFromHost("v", "vibe");
			s.clearAgentPty("v");
			expect(ops).toEqual([
				{ op: "agent", ptyId: "v", agentId: "vibe" },
				{ op: "agent", ptyId: "v", agentId: null },
			]);
		} finally {
			__captureStatusOpsForTests(null);
		}
	});
});

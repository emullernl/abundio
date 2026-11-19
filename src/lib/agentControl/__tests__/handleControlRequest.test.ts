import { beforeEach, describe, expect, it, vi } from "vitest";

const paneNumbers = vi.fn();
vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: (...a: unknown[]) => paneNumbers(...a),
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
	},
	tabs: { update: async () => {} },
}));

const terminals = new Map<string, unknown>();
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
	startPtyUnlessShown: () => () => {},
	noteControlInput: vi.fn(),
}));

import {
	BADGE_MIN_VISIBLE_MS,
	useControlBadgeStore,
} from "../../../stores/controlBadgeStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { noteControlInput } from "../../terminalManager";
import type { WorkspaceWithTabs } from "../../types";
import {
	applyControlEffect,
	runRequest,
	toReply,
} from "../handleControlRequest";
import { ControlError } from "../types";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "ws" };

const layout = {
	type: "split",
	id: "s",
	direction: "horizontal",
	ratio: 0.5,
	first: { type: "terminal", id: "a", ptyId: "pty-a" },
	second: {
		type: "terminal",
		id: "b",
		ptyId: "pty-b",
		agentId: "claude",
		agentHandle: "rev",
	},
};

beforeEach(() => {
	terminals.clear();
	paneNumbers.mockImplementation(async (_ws: string, ids: string[]) =>
		ids.map((id, i) => [id, i + 1]),
	);
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws",
				tabs: [
					{
						id: "t",
						workspaceId: "ws",
						name: "Main",
						layoutJson: JSON.stringify(layout),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			} as unknown as WorkspaceWithTabs,
		],
		ptyStatuses: {},
	});
	const s = usePtyActivityStore.getState();
	usePtyActivityStore.setState({
		activities: {
			...s.activities,
			"pty-b": {
				state: "ready",
				detectionMode: "agent",
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				hookDriven: true,
				shellCommandRunning: false,
			} as never,
		},
	});
});

describe("runRequest", () => {
	it("opens the caller's own Workspace for Rust's reads: nothing to do", async () => {
		expect(await runRequest(caller, { op: "workspace.open" })).toEqual({
			opened: true,
		});
	});

	it("reports a Workspace this Window does not have", async () => {
		await expect(
			runRequest({ ...caller, workspaceId: "other" }, { op: "workspace.open" }),
		).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("a call Rust answers", () => {
	it("shows the target's badge from begin to end", () => {
		applyControlEffect({
			type: "begin",
			id: "e1",
			callerPaneId: "a",
			targetPaneId: "b",
			by: "p1",
			kind: "read",
		});
		expect(useControlBadgeStore.getState().badges.b).toMatchObject({
			by: "p1",
		});
		vi.useFakeTimers();
		applyControlEffect({ type: "end", id: "e1" });
		applyControlEffect({ type: "end", id: "e1" });
		vi.advanceTimersByTime(BADGE_MIN_VISIBLE_MS);
		vi.useRealTimers();
		expect(useControlBadgeStore.getState().badges.b).toBeUndefined();
	});
});

describe("toReply", () => {
	it("wraps results and errors", () => {
		expect(toReply({ status: "fulfilled", value: { a: 1 } })).toEqual({
			result: { a: 1 },
		});
		expect(
			toReply({ status: "rejected", reason: new ControlError("busy", "no") }),
		).toEqual({ error: { code: "busy", message: "no" } });
		expect(toReply({ status: "rejected", reason: new Error("boom") })).toEqual({
			error: { code: "internal", message: "boom" },
		});
	});
});

describe("input Rust typed", () => {
	it("is kept as keystrokes in the pane", () => {
		applyControlEffect({ type: "input", paneId: "b", data: "\r" });
		expect(noteControlInput).toHaveBeenCalledWith("b", "\r");
	});
});

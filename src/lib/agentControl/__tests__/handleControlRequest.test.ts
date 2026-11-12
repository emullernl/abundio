import { beforeEach, describe, expect, it, vi } from "vitest";

const paneNumbers = vi.fn();
vi.mock("../../ipc", () => ({
	agentControl: { paneNumbers: (...a: unknown[]) => paneNumbers(...a) },
}));

const terminals = new Map<string, unknown>();
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
}));

import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { WorkspaceWithTabs } from "../../types";
import { runRequest, toReply } from "../handleControlRequest";
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
	it("lists panes, numbering them in order", async () => {
		const r = (await runRequest(caller, { op: "pane.list" })) as {
			panes: { pane: string; self: boolean }[];
		};
		expect(paneNumbers).toHaveBeenCalledWith("ws", ["a", "b"]);
		expect(r.panes.map((p) => [p.pane, p.self])).toEqual([
			["p1", true],
			["p2", false],
		]);
	});

	it("lists only agent-mode panes as Agents", async () => {
		const r = (await runRequest(caller, { op: "agent.list" })) as {
			agents: { handle: string; status: string }[];
		};
		expect(r.agents).toEqual([
			expect.objectContaining({
				handle: "rev",
				status: "ready",
				agent: "claude",
			}),
		]);
	});

	it("resolves a handle to its pane id", async () => {
		expect(
			await runRequest(caller, {
				op: "resolve",
				target: { kind: "handle", value: "rev" },
			}),
		).toEqual({ paneId: "b" });
	});

	it("reads a mounted terminal", async () => {
		const rows = ["$ echo hi", "hi", ""];
		terminals.set("b", {
			ptyId: "pty-b",
			term: {
				rows: 24,
				buffer: {
					active: {
						length: rows.length,
						viewportY: 0,
						getLine: (y: number) => ({
							isWrapped: false,
							translateToString: () => rows[y],
						}),
					},
				},
			},
		});
		expect(
			await runRequest(caller, {
				op: "pane.read",
				target: { kind: "pane", value: 2 },
				lines: null,
				visible: false,
			}),
		).toEqual({ pane: "p2", lines: 2, text: "$ echo hi\nhi" });
	});

	it("refuses to read a terminal that is not loaded", async () => {
		await expect(
			runRequest(caller, {
				op: "pane.read",
				target: { kind: "pane", value: 1 },
				lines: null,
				visible: false,
			}),
		).rejects.toMatchObject({ code: "state_unknown" });
	});

	it("reports a Workspace this Window does not have", async () => {
		await expect(
			runRequest({ ...caller, workspaceId: "other" }, { op: "pane.list" }),
		).rejects.toMatchObject({ code: "not_found" });
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

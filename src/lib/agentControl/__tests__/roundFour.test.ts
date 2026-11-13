import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
	},
	tabs: { update: async () => {} },
}));
vi.mock("../../terminalManager", () => ({
	getTerminal: () => undefined,
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: () => {},
	onAction: async () => () => {},
}));

import { useAgentSignalsStore } from "../../../stores/agentSignalsStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { WorkspaceWithTabs } from "../../types";
import { runRequest } from "../handleControlRequest";

// `b` runs an Agent, `a` is a plain shell.
const agent = { ptyId: "pty-b", paneId: "b", workspaceId: "ws" };
const shell = { ptyId: "pty-a", paneId: "a", workspaceId: "ws" };

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
		agentHandle: "Builder",
	},
};

function activity(mode: "agent" | "shell") {
	return {
		state: "active",
		detectionMode: mode,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		hookDriven: true,
		shellCommandRunning: false,
	} as never;
}

beforeEach(() => {
	useAgentSignalsStore.setState({ flags: {}, progress: {}, questions: {} });
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws",
				name: "home",
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
	usePtyActivityStore.setState({
		activities: { "pty-a": activity("shell"), "pty-b": activity("agent") },
		panePtyMap: { a: "pty-a", b: "pty-b" },
	});
});

describe("progress", () => {
	it("sets, replaces and clears the caller's own Progress line", async () => {
		await runRequest(agent, { op: "progress", text: "step 1/3" });
		await runRequest(agent, { op: "progress", text: "step 2/3" });
		expect(useAgentSignalsStore.getState().progress.b).toBe("step 2/3");
		const list = (await runRequest(shell, { op: "agent.list" })) as {
			agents: { handle: string; progress: string | null }[];
		};
		expect(list.agents[0]).toMatchObject({
			handle: "Builder",
			progress: "step 2/3",
		});
		await runRequest(agent, { op: "progress", text: null });
		expect(useAgentSignalsStore.getState().progress.b).toBeUndefined();
	});

	it("is refused from a plain shell, as notify is", async () => {
		await expect(
			runRequest(shell, { op: "progress", text: "x" }),
		).rejects.toMatchObject({ code: "agents_only" });
		await expect(
			runRequest(shell, { op: "notify", message: "x" }),
		).rejects.toMatchObject({ code: "agents_only" });
	});
});

describe("notify", () => {
	it("flags the caller's own pane", async () => {
		const r = await runRequest(agent, { op: "notify", message: "Look" });
		expect(r).toMatchObject({ flagged: true });
		expect(useAgentSignalsStore.getState().flags.b.message).toBe("Look");
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
	},
	tabs: { update: async () => {} },
	notes: {
		get: async () => "",
		set: async (...a: unknown[]) => {
			noteSets.push(a);
		},
	},
}));
const noteSets: unknown[] = vi.hoisted(() => []);
vi.mock("../../terminalManager", () => ({
	getTerminal: () => undefined,
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: () => {},
	onAction: async () => () => {},
}));

import { useAgentSignalsStore } from "../../../stores/agentSignalsStore";
import { useNotesStore } from "../../../stores/notesStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { registerNotesEditor } from "../../notesEditors";
import type { WorkspaceWithTabs } from "../../types";
import { answerQuestion } from "../askUser";
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

describe("ask", () => {
	const ask = (
		over: Partial<{ choices: string[]; text: boolean }> = {},
		signal = new AbortController().signal,
	) =>
		runRequest(
			agent,
			{
				op: "ask",
				question: "Ship it?",
				choices: ["yes", "no"],
				text: true,
				timeoutMs: null,
				...over,
			},
			signal,
		);
	const open = () => useAgentSignalsStore.getState().questions.b;

	it("opens a card on the caller's pane and returns the chosen answer", async () => {
		const p = ask();
		await vi.waitFor(() => expect(open()).toBeDefined());
		expect(open()).toMatchObject({
			question: "Ship it?",
			choices: ["yes", "no"],
		});
		answerQuestion("b", open().id, { choice: "yes", text: null });
		await expect(p).resolves.toEqual({ choice: "yes", text: null });
		expect(open()).toBeUndefined();
	});

	it("always offers text when there are no choices", async () => {
		const p = ask({ choices: [], text: false });
		await vi.waitFor(() => expect(open()).toBeDefined());
		expect(open().text).toBe(true);
		answerQuestion("b", open().id, { choice: null, text: "tomorrow" });
		await expect(p).resolves.toEqual({ choice: null, text: "tomorrow" });
	});

	it("refuses a second question while one is open", async () => {
		const first = ask();
		await vi.waitFor(() => expect(open()).toBeDefined());
		await expect(ask()).rejects.toMatchObject({ code: "busy" });
		answerQuestion("b", open().id, { choice: "no", text: null });
		await first;
	});

	it("ends when the call is cancelled, removing the card", async () => {
		const ac = new AbortController();
		const p = ask({}, ac.signal);
		await vi.waitFor(() => expect(open()).toBeDefined());
		ac.abort();
		await expect(p).rejects.toMatchObject({ code: "cancelled" });
		expect(open()).toBeUndefined();
	});

	it("ends when the pane closes", async () => {
		const p = ask();
		await vi.waitFor(() => expect(open()).toBeDefined());
		useAgentSignalsStore.getState().clearPane("b");
		await expect(p).rejects.toMatchObject({ code: "exited" });
	});

	it("ends when the Agent's turn ends", async () => {
		const p = ask();
		await vi.waitFor(() => expect(open()).toBeDefined());
		usePtyActivityStore.getState().applyHookEvent("pty-b", "ready");
		await expect(p).rejects.toMatchObject({ code: "exited" });
		expect(open()).toBeUndefined();
	});

	it("is refused from a plain shell", async () => {
		await expect(
			runRequest(shell, {
				op: "ask",
				question: "q",
				choices: [],
				text: true,
				timeoutMs: null,
			}),
		).rejects.toMatchObject({ code: "agents_only" });
	});
});

describe("notes", () => {
	beforeEach(() => {
		useNotesStore.setState({
			contentByWorkspaceId: {
				ws: JSON.stringify({
					type: "doc",
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "Mine" }] },
					],
				}),
			},
			loadedWorkspaceIds: new Set(["ws"]),
		});
		noteSets.length = 0;
	});

	it("reads the freshest copy and appends, signed, from any pane", async () => {
		await runRequest(shell, { op: "notes.append", text: "- [ ] run tests" });
		expect(await runRequest(agent, { op: "notes.read" })).toEqual({
			notes: "Mine\n**p1:**\n- [ ] run tests",
		});
		// Written at once, not left to the debounce.
		expect(noteSets).toHaveLength(1);
	});

	it("goes through an open editor, leaving the user's selection", async () => {
		const insertContentAt = vi.fn();
		const unregister = registerNotesEditor("ws", {
			isDestroyed: false,
			isEmpty: false,
			state: { doc: { content: { size: 6 } } },
			commands: { insertContentAt, setContent: vi.fn() },
		} as never);
		await runRequest(agent, { op: "notes.append", text: "done" });
		expect(insertContentAt).toHaveBeenCalledWith(
			6,
			[
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Builder:", marks: [{ type: "bold" }] },
						{ type: "text", text: " " },
						{ type: "text", text: "done" },
					],
				},
			],
			{ updateSelection: false },
		);
		unregister();
	});
});

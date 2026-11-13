import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const write = vi.fn(async () => {});
type HandleCheck =
	| { ok: true }
	| { ok: false; code: "handle_taken" | "invalid_handle"; message: string };
const handleCheck = vi.fn(
	async (_ws: string, _pane: string, _h: string): Promise<HandleCheck> => ({
		ok: true,
	}),
);
const ensure = vi.fn(async () => {});
let defaultShell = "/bin/zsh";
vi.mock("../../ipc", () => ({
	agentControl: {
		handleCheck: (ws: string, pane: string, h: string) =>
			handleCheck(ws, pane, h),
		handleDefault: async () => "Agent One",
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
	},
	tabs: { update: async () => {} },
	pty: { write: (...a: unknown[]) => write(...(a as [])) },
	agentHooks: { ensure: (...a: unknown[]) => ensure(...(a as [])) },
	shells: { default: async () => defaultShell },
}));

const terminals = new Map<string, unknown>();
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
	teardownTerminal: () => {},
}));

const revealed: string[] = [];
vi.mock("../../paneLocation", () => ({
	revealPane: (paneId: string) => revealed.push(paneId),
}));

const closed: { paneId: string; opts: unknown }[] = [];
vi.mock("../../closePane", () => ({
	closePaneNow: async (paneId: string, opts: unknown) => {
		closed.push({ paneId, opts });
	},
}));

import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { takePendingTask } from "../../pendingAgentRegistry";
import type { CodingAgent, PaneNode, WorkspaceWithTabs } from "../../types";
import { runRequest } from "../handleControlRequest";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "ws" };

function setLayout(layout: PaneNode) {
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
		focusedPaneId: "a",
	});
}

function layout(): PaneNode {
	return JSON.parse(
		useWorkspaceStore.getState().workspaces[0].tabs[0].layoutJson,
	);
}

function activity(ptyId: string, over: Partial<PtyActivityEntry>) {
	usePtyActivityStore.setState((s) => ({
		activities: {
			...s.activities,
			[ptyId]: {
				state: "idle",
				detectionMode: "shell",
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				hookDriven: false,
				shellCommandRunning: false,
				...over,
			} as PtyActivityEntry,
		},
	}));
}

const claude: CodingAgent = {
	id: "claude",
	name: "Claude Code",
	command: "claude",
	taskArgs: ["{prompt}"],
	builtin: true,
	enabled: true,
};

beforeEach(() => {
	write.mockClear();
	ensure.mockClear();
	handleCheck.mockClear();
	closed.length = 0;
	revealed.length = 0;
	defaultShell = "/bin/zsh";
	terminals.clear();
	terminals.set("a", {
		ptyId: "pty-a",
		shellIntegrationSeen: true,
		term: { cols: 200, rows: 40 },
	});
	setLayout({ type: "terminal", id: "a", ptyId: "pty-a" });
	useSettingsStore.setState({
		agents: [claude],
		shellPath: "",
		agentHooksEnabled: true,
	});
	activity("pty-a", {});
});

afterEach(() => vi.useRealTimers());

describe("pane split", () => {
	it("splits the caller right when wide, owned by it, without moving focus", async () => {
		const r = (await runRequest(caller, {
			op: "pane.split",
			direction: null,
			focus: false,
		})) as { pane: string; spawnedBy: string };
		const tree = layout() as Extract<PaneNode, { type: "split" }>;
		expect(tree.type).toBe("split");
		expect(tree.direction).toBe("vertical");
		expect(tree.second).toMatchObject({
			type: "terminal",
			ptyId: "",
			spawnedBy: "a",
		});
		expect(r).toMatchObject({ pane: "p2", spawnedBy: "p1" });
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("a");
	});

	it("adds no hint when the Tab has room", async () => {
		const r = await runRequest(caller, {
			op: "pane.split",
			direction: null,
			focus: false,
		});
		expect(r).not.toHaveProperty("hint");
	});

	it("hints at --tab when the split leaves cramped panes", async () => {
		terminals.set("a", { ptyId: "pty-a", term: { cols: 100, rows: 40 } });
		const r = (await runRequest(caller, {
			op: "pane.split",
			direction: null,
			focus: false,
		})) as { hint?: string };
		expect(r.hint).toContain("--tab");
		// The split still happened.
		expect(layout().type).toBe("split");
	});

	it("splits down when tall, or as asked", async () => {
		terminals.set("a", { ptyId: "pty-a", term: { cols: 60, rows: 40 } });
		await runRequest(caller, {
			op: "pane.split",
			direction: null,
			focus: false,
		});
		expect((layout() as { direction: string }).direction).toBe("horizontal");
		setLayout({ type: "terminal", id: "a", ptyId: "pty-a" });
		await runRequest(caller, {
			op: "pane.split",
			direction: "right",
			focus: false,
		});
		expect((layout() as { direction: string }).direction).toBe("vertical");
	});
});

describe("agent start", () => {
	const start = (
		over: Partial<{
			handle: string | null;
			prompt: string | null;
			focus: boolean;
		}> = {},
	) =>
		runRequest(caller, {
			op: "agent.start",
			handle: null,
			kind: "claude",
			prompt: "fix it",
			direction: null,
			args: [],
			focus: false,
			tab: false,
			tabName: null,
			...over,
		});

	it("seeds a task launch in a new named pane, then answers in agent mode", async () => {
		vi.useFakeTimers();
		const p = start({ handle: "fixer" });
		await vi.advanceTimersByTimeAsync(10);
		const node = (
			layout() as { second: Extract<PaneNode, { type: "terminal" }> }
		).second;
		expect(node).toMatchObject({
			agentId: "claude",
			agentHandle: "fixer",
			spawnedBy: "a",
		});
		expect(ensure).toHaveBeenCalledWith("claude", true);
		// Without --focus the user stays where they are typing.
		expect(revealed).toEqual([]);
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("a");
		terminals.set(node.id, { ptyId: "pty-new", term: {} });
		activity("pty-new", { detectionMode: "agent", state: "active" });
		await vi.advanceTimersByTimeAsync(500);
		await expect(p).resolves.toMatchObject({
			pane: "p2",
			handle: "fixer",
			agent: "claude",
			status: "working",
		});
		expect(takePendingTask(node.id)).toEqual({
			argv: ["claude", "fix it"],
			agentId: "claude",
		});
	});

	it("with --focus, reveals the new pane as soon as it exists", async () => {
		vi.useFakeTimers();
		const p = start({ focus: true });
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(10);
		const node = (layout() as { second: { id: string } }).second;
		expect(revealed).toEqual([node.id]);
		await vi.advanceTimersByTimeAsync(31_000);
		await settled;
	});

	it("stalls when the Agent never starts", async () => {
		vi.useFakeTimers();
		const p = start();
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(31_000);
		await settled;
	});

	it("refuses another shell than zsh or bash", async () => {
		defaultShell = "/usr/bin/fish";
		await expect(start()).rejects.toMatchObject({ code: "unsupported_shell" });
		expect(layout().type).toBe("terminal");
	});

	it("refuses a handle that is taken, before splitting", async () => {
		setLayout({
			type: "terminal",
			id: "a",
			ptyId: "pty-a",
			agentHandle: "fixer",
		});
		await expect(start({ handle: "fixer" })).rejects.toMatchObject({
			code: "handle_taken",
		});
		expect(layout().type).toBe("terminal");
	});

	it("asks Rust about the whole Profile, for the new pane, before splitting", async () => {
		handleCheck.mockResolvedValueOnce({
			ok: false,
			code: "handle_taken",
			message: 'an Agent in the Workspace "api" is already called "fixer"',
		});
		await expect(start({ handle: "fixer" })).rejects.toMatchObject({
			code: "handle_taken",
			message: expect.stringContaining('"api"'),
		});
		expect(handleCheck).toHaveBeenCalledWith("ws", expect.any(String), "fixer");
		expect(layout().type).toBe("terminal");
	});

	it("refuses the name when the Profile-wide check cannot run", async () => {
		handleCheck.mockRejectedValueOnce(new Error("db"));
		await expect(start({ handle: "fixer" })).rejects.toMatchObject({
			code: "internal",
		});
		expect(layout().type).toBe("terminal");
	});

	it("checks the name for the pane it then creates", async () => {
		vi.useFakeTimers();
		const p = start({ handle: "fixer" });
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(10);
		const node = (layout() as { second: { id: string } }).second;
		expect(handleCheck).toHaveBeenCalledWith("ws", node.id, "fixer");
		await vi.advanceTimersByTimeAsync(31_000);
		await settled;
	});
});

describe("pane run", () => {
	beforeEach(() => {
		setLayout({
			type: "split",
			id: "s",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", id: "a", ptyId: "pty-a" },
			second: { type: "terminal", id: "b", ptyId: "pty-b" },
		});
		terminals.set("b", {
			ptyId: "pty-b",
			shellIntegrationSeen: true,
			term: {},
		});
		activity("pty-b", {});
	});
	const run = (command: string) =>
		runRequest(caller, {
			op: "pane.run",
			target: { kind: "pane", value: 2 },
			command,
		});

	it("types the command and Enter into an idle shell", async () => {
		await expect(run("make test")).resolves.toEqual({ pane: "p2", sent: true });
		expect(write).toHaveBeenCalledWith("pty-b", "make test\r");
	});

	it("refuses while a command runs", async () => {
		activity("pty-b", { shellCommandRunning: true });
		await expect(run("ls")).rejects.toMatchObject({ code: "busy" });
		expect(write).not.toHaveBeenCalled();
	});

	it("refuses a shell with no integration seen", async () => {
		terminals.set("b", {
			ptyId: "pty-b",
			shellIntegrationSeen: false,
			term: {},
		});
		await expect(run("ls")).rejects.toMatchObject({ code: "state_unknown" });
	});
});

describe("pane close", () => {
	beforeEach(() => {
		setLayout({
			type: "split",
			id: "s",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", id: "a", ptyId: "pty-a" },
			second: {
				type: "split",
				id: "s2",
				direction: "horizontal",
				ratio: 0.5,
				first: { type: "terminal", id: "b", ptyId: "pty-b", spawnedBy: "a" },
				second: { type: "terminal", id: "c", ptyId: "pty-c" },
			},
		});
	});
	const close = (n: number) =>
		runRequest(caller, {
			op: "pane.close",
			target: { kind: "pane", value: n },
		});

	it("closes a pane the caller spawned, keeping focus", async () => {
		await expect(close(2)).resolves.toEqual({ pane: "p2", closed: true });
		expect(closed).toEqual([{ paneId: "b", opts: { keepFocus: true } }]);
	});

	it("refuses a pane it did not spawn, and its own", async () => {
		await expect(close(3)).rejects.toMatchObject({ code: "not_owner" });
		await expect(close(1)).rejects.toMatchObject({ code: "not_owner" });
		expect(closed).toEqual([]);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
	},
	tabs: { update: async () => {} },
	pty: {
		onOutput: (ptyId: string, cb: (d: Uint8Array) => void) => {
			outputs.set(ptyId, cb);
			return Promise.resolve(() => outputs.delete(ptyId));
		},
	},
	worktrees: {
		list: async () => worktreeList,
	},
	shells: { default: async () => "/bin/zsh" },
	agentHooks: { ensure: async () => {} },
	notes: {
		get: async () => "",
		set: async (...a: unknown[]) => {
			noteSets.push(a);
		},
	},
}));
const noteSets: unknown[] = vi.hoisted(() => []);
let worktreeList: { path: string; branch: string | null }[] = [];
const outputs = vi.hoisted(() => new Map<string, (d: Uint8Array) => void>());
vi.mock("../../terminalManager", () => ({
	getTerminal: () => undefined,
	startPtyUnlessShown: () => () => {},
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: () => {},
	onAction: async () => () => {},
}));

import { useAgentSignalsStore } from "../../../stores/agentSignalsStore";
import { useNotesStore } from "../../../stores/notesStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { registerNotesEditor } from "../../notesEditors";
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
	useAgentSignalsStore.setState({ flags: {}, progress: {} });
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

describe("pane watch", () => {
	const watch = (pattern: string, ignoreCase = false) =>
		runRequest(agent, {
			op: "pane.watch",
			target: { kind: "pane", value: 1 },
			pattern,
			ignoreCase,
			timeoutMs: null,
		});
	const print = (s: string) =>
		outputs.get("pty-a")?.(new TextEncoder().encode(s));

	it("returns the first matching line of new output", async () => {
		const p = watch("ready in \\d+ms", true);
		await vi.waitFor(() => expect(outputs.has("pty-a")).toBe(true));
		print("\x1b[32mVITE\x1b[0m starting\r\n");
		print("  READY in 312ms\r\n");
		await expect(p).resolves.toEqual({ line: "  READY in 312ms" });
		expect(outputs.has("pty-a")).toBe(false);
	});

	it("ends when the PTY exits", async () => {
		const p = watch("never");
		await vi.waitFor(() => expect(outputs.has("pty-a")).toBe(true));
		useWorkspaceStore.setState({
			ptyStatuses: { "pty-a": { type: "exited", code: 0 } as never },
		});
		await expect(p).rejects.toMatchObject({ code: "exited" });
	});

	it("refuses a broken pattern", async () => {
		await expect(watch("(")).rejects.toMatchObject({ code: "invalid_pattern" });
	});
});

describe("worktree new", () => {
	const created: unknown[][] = [];
	beforeEach(() => {
		created.length = 0;
		worktreeList = [];
		useSettingsStore.setState({
			agents: [
				{
					id: "claude",
					name: "Claude Code",
					command: "claude",
					taskArgs: ["{prompt}"],
					builtin: true,
					enabled: true,
				},
			],
			agentHooksEnabled: false,
			shellPath: "/bin/zsh",
		});
		useWorkspaceStore.setState((st) => ({
			workspaces: st.workspaces.map((w) => ({
				...w,
				rootFolder: "/src/home",
				worktreeSetupCommands: "pnpm i",
			})),
		}));
		useWorkspaceGitStore.setState({
			worktreeFacts: { ws: { isMainWorktree: true } as never },
		});
		// The new Workspace, as the store would add it; its first pane is
		// seeded with the Agent's task.
		useWorkspaceStore.setState({
			createWorktreeWorkspace: async (...args: unknown[]) => {
				created.push(args);
				const ws = {
					id: "ws-new",
					name: "home.worktrees-feat-x",
					rootFolder: "/src/home.worktrees/feat-x",
					tabs: [
						{
							id: "t-new",
							workspaceId: "ws-new",
							name: "go",
							layoutJson: JSON.stringify({
								type: "terminal",
								id: "n1",
								ptyId: "",
							}),
							position: 0,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				} as unknown as WorkspaceWithTabs;
				useWorkspaceStore.setState((st) => ({
					workspaces: [...st.workspaces, ws],
				}));
				(
					args[5] as { task?: { onSeeded?: (id: string) => void } }
				).task?.onSeeded?.("n1");
				return ws;
			},
		} as never);
	});

	it("creates the worktree in the usual folder, in the background, with setup commands", async () => {
		const r = await runRequest(agent, {
			op: "worktree.new",
			branch: "feat/x",
			agent: null,
			focus: false,
		});
		expect(created[0].slice(0, 5)).toEqual([
			"/src/home",
			"feat/x",
			"/src/home.worktrees/feat-x",
			"pnpm i",
			undefined,
		]);
		expect(created[0][5]).toMatchObject({ background: true });
		expect(r).toEqual({
			workspace: "home.worktrees-feat-x",
			folder: "/src/home.worktrees/feat-x",
			branch: "feat/x",
		});
	});

	it("starts an Agent there that the caller owns, named as asked", async () => {
		usePtyActivityStore.setState((st) => ({
			panePtyMap: { ...st.panePtyMap, n1: "pty-n1" },
			activities: { ...st.activities, "pty-n1": activity("agent") },
		}));
		const r = (await runRequest(agent, {
			op: "worktree.new",
			branch: "feat/x",
			agent: { kind: "claude", prompt: "go", handle: "Helper", args: [] },
			focus: true,
		})) as { agent: { handle: string } };
		expect(created[0][5]).toMatchObject({
			background: false,
			task: { argv: ["claude", "go"], agentId: "claude" },
		});
		const tab = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === "ws-new")?.tabs[0];
		expect(JSON.parse(tab?.layoutJson ?? "{}")).toMatchObject({
			id: "n1",
			spawnedBy: "b",
			agentHandle: "Helper",
		});
		expect(r.agent.handle).toBe("Helper");
	});

	it("refuses a branch checked out elsewhere", async () => {
		worktreeList = [{ path: "/src/other", branch: "feat/x" }];
		await expect(
			runRequest(agent, {
				op: "worktree.new",
				branch: "feat/x",
				agent: null,
				focus: false,
			}),
		).rejects.toMatchObject({ code: "branch_in_use" });
		expect(created).toHaveLength(0);
	});

	it("is for Agents only", async () => {
		await expect(
			runRequest(shell, {
				op: "worktree.new",
				branch: "x",
				agent: null,
				focus: false,
			}),
		).rejects.toMatchObject({ code: "agents_only" });
	});
});

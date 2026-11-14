import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tabUpdates: [string, Record<string, unknown>][] = [];
let created = 0;
vi.mock("../../ipc", () => ({
	agentControl: {
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
	},
	tabs: {
		update: async (id: string, u: Record<string, unknown>) => {
			tabUpdates.push([id, u]);
		},
		create: async (workspaceId: string, name: string) => {
			created++;
			return {
				id: `new-tab-${created}`,
				workspaceId,
				name,
				layoutJson: JSON.stringify({
					type: "terminal",
					id: `new-pane-${created}`,
					ptyId: "",
				}),
				position: 9,
				createdAt: 0,
				updatedAt: 0,
			};
		},
	},
	pty: { write: async () => {} },
	agentHooks: { ensure: async () => {} },
	shells: { default: async () => "/bin/zsh" },
}));

const terminals = new Map<string, unknown>();
const startedHidden: [string, unknown][] = [];
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
	teardownTerminal: () => {},
	startPtyUnlessShown: (id: string, size: unknown) => {
		startedHidden.push([id, size]);
		return () => {};
	},
}));

const revealed: [string, string, string][] = [];
vi.mock("../../paneLocation", () => ({
	revealPane: (paneId: string, ws: string, tab: string) =>
		revealed.push([paneId, ws, tab]),
}));

import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { takePendingTask } from "../../pendingAgentRegistry";
import type {
	CodingAgent,
	PaneNode,
	Tab,
	WorkspaceWithTabs,
} from "../../types";
import { runRequest } from "../handleControlRequest";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "ws" };

const claude: CodingAgent = {
	id: "claude",
	name: "Claude Code",
	command: "claude",
	taskArgs: ["{prompt}"],
	builtin: true,
	enabled: true,
};

function tab(id: string, layout: PaneNode, extra: Partial<Tab> = {}): Tab {
	return {
		id,
		workspaceId: "ws",
		name: `Tab ${id}`,
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...extra,
	};
}

function setTabs(tabs: Tab[]) {
	useWorkspaceStore.setState({
		workspaces: [{ id: "ws", tabs } as unknown as WorkspaceWithTabs],
		ptyStatuses: {},
		activeWorkspaceId: "ws",
		activeTabByWorkspace: { ws: "t1" },
		focusedPaneId: "a",
		focusedPaneByTab: {},
	});
}

const tabs = () => useWorkspaceStore.getState().workspaces[0].tabs;
const lastTab = () => tabs()[tabs().length - 1];
const paneOf = (t: Tab) =>
	JSON.parse(t.layoutJson) as Extract<PaneNode, { type: "terminal" }>;

function toAgentMode(paneId: string) {
	terminals.set(paneId, { ptyId: `pty-${paneId}`, term: {} });
	usePtyActivityStore.setState((s) => ({
		activities: {
			...s.activities,
			[`pty-${paneId}`]: {
				state: "active",
				detectionMode: "agent",
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				hookDriven: true,
				shellCommandRunning: false,
			} as PtyActivityEntry,
		},
	}));
}

beforeEach(() => {
	tabUpdates.length = 0;
	revealed.length = 0;
	terminals.clear();
	terminals.set("a", { ptyId: "pty-a", term: { cols: 200, rows: 40 } });
	setTabs([tab("t1", { type: "terminal", id: "a", ptyId: "pty-a" })]);
	useSettingsStore.setState({
		agents: [claude],
		shellPath: "",
		agentHooksEnabled: false,
	});
});

afterEach(() => vi.useRealTimers());

const start = (
	over: Partial<{
		handle: string | null;
		prompt: string | null;
		tabName: string | null;
		focus: boolean;
	}> = {},
) =>
	runRequest(caller, {
		op: "agent.start",
		handle: null,
		kind: "claude",
		prompt: "Fix the flaky login test",
		direction: null,
		args: [],
		focus: false,
		tab: true,
		tabName: null,
		...over,
	});

async function startAndSettle(over: Parameters<typeof start>[0] = {}) {
	vi.useFakeTimers();
	const p = start(over);
	await vi.advanceTimersByTimeAsync(10);
	const t = lastTab();
	toAgentMode(paneOf(t).id);
	await vi.advanceTimersByTimeAsync(500);
	return { reply: await p, tab: t };
}

describe("agent start --tab", () => {
	it("opens a Tab at the end, seeded, without moving the user", async () => {
		const { reply, tab: t } = await startAndSettle({ handle: "fixer" });
		expect(tabs().map((x) => x.id)).toEqual(["t1", t.id]);
		expect(t.name).toBe("Fix the flaky login test");
		expect(paneOf(t)).toMatchObject({
			agentId: "claude",
			agentHandle: "fixer",
			spawnedBy: "a",
		});
		// The owned pane is written to the database, not just held in memory.
		expect(tabUpdates).toContainEqual([
			t.id,
			{ layoutJson: expect.stringContaining('"spawnedBy":"a"') },
		]);
		const s = useWorkspaceStore.getState();
		expect(s.activeTabByWorkspace.ws).toBe("t1");
		expect(s.focusedPaneId).toBe("a");
		expect(revealed).toEqual([]);
		// Nothing shows the new Tab, so its Agent must start without it.
		expect(startedHidden.map(([id]) => id)).toContain(paneOf(t).id);
		expect(reply).toMatchObject({
			handle: "fixer",
			agent: "claude",
			tab: "Fix the flaky login test",
			spawnedBy: "p1",
		});
	});

	it("seeds the task launch for the new pane", async () => {
		vi.useFakeTimers();
		const p = start();
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(10);
		expect(takePendingTask(paneOf(lastTab()).id)).toEqual({
			argv: ["claude", "Fix the flaky login test"],
			agentId: "claude",
		});
		await vi.advanceTimersByTimeAsync(31_000);
		await settled;
	});

	it("names the Tab: --tab-name, else the task, else the handle, else the Agent", async () => {
		expect((await startAndSettle({ tabName: "Review" })).tab.name).toBe(
			"Review",
		);
		expect(
			(await startAndSettle({ prompt: null, handle: "rev" })).tab.name,
		).toBe("rev");
		expect((await startAndSettle({ prompt: null })).tab.name).toBe(
			"Claude Code",
		);
	});

	it("never hints: it already took a Tab of its own", async () => {
		terminals.set("a", { ptyId: "pty-a", term: { cols: 40, rows: 10 } });
		const { reply } = await startAndSettle();
		expect(reply).not.toHaveProperty("hint");
	});

	it("with --focus, reveals the new Tab's pane", async () => {
		const { tab: t } = await startAndSettle({ focus: true });
		expect(revealed).toEqual([[paneOf(t).id, "ws", t.id]]);
	});
});

describe("tab new", () => {
	it("opens a shell in a new Tab with the usual default name", async () => {
		const reply = await runRequest(caller, {
			op: "tab.new",
			name: null,
			focus: false,
		});
		const t = lastTab();
		expect(t.name).toBe("Terminal 2");
		expect(paneOf(t)).toMatchObject({ spawnedBy: "a" });
		expect(paneOf(t)).not.toHaveProperty("agentId");
		expect(reply).toMatchObject({ mode: "shell", tab: "Terminal 2" });
		expect(useWorkspaceStore.getState().activeTabByWorkspace.ws).toBe("t1");
	});

	it("takes a name and --focus", async () => {
		await runRequest(caller, { op: "tab.new", name: "Logs", focus: true });
		const t = lastTab();
		expect(t.name).toBe("Logs");
		expect(revealed).toEqual([[paneOf(t).id, "ws", t.id]]);
	});
});

describe("tab rename", () => {
	beforeEach(() => {
		setTabs([
			tab("t1", { type: "terminal", id: "a", ptyId: "pty-a" }),
			tab("t2", { type: "terminal", id: "b", ptyId: "pty-b" }, { position: 1 }),
			tab(
				"t3",
				{ type: "terminal", id: "c", ptyId: "pty-c", spawnedBy: "a" },
				{ position: 2 },
			),
		]);
	});
	const rename = (name: string, value?: number) =>
		runRequest(caller, {
			op: "tab.rename",
			name,
			target: value === undefined ? null : { kind: "pane", value },
		});
	const nameOf = (id: string) => tabs().find((t) => t.id === id)?.name;

	it("renames the caller's own Tab", async () => {
		await expect(rename("Login fix")).resolves.toEqual({
			tab: "Login fix",
			renamed: true,
		});
		expect(nameOf("t1")).toBe("Login fix");
		expect(tabUpdates).toContainEqual(["t1", { name: "Login fix" }]);
	});

	it("renames a Tab it opened, addressed by a pane in it", async () => {
		await rename("Helper", 3);
		expect(nameOf("t3")).toBe("Helper");
	});

	it("renames a Tab it did not open, one the user named included", async () => {
		await rename("X", 2);
		expect(nameOf("t2")).toBe("X");
	});
});

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
				spawnedByPane: null,
				userNamed: false,
			};
		},
	},
	pty: { write: async () => {} },
	agentHooks: { ensure: async () => {} },
	shells: { default: async () => "/bin/zsh" },
}));

const terminals = new Map<string, unknown>();
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
	teardownTerminal: () => {},
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
import { tabRenameRefusal } from "../spawn";

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
	it("opens a Spawned tab at the end, seeded, without moving the user", async () => {
		const { reply, tab: t } = await startAndSettle({ handle: "fixer" });
		expect(tabs().map((x) => x.id)).toEqual(["t1", t.id]);
		expect(t).toMatchObject({
			name: "Fix the flaky login test",
			spawnedByPane: "a",
		});
		expect(paneOf(t)).toMatchObject({
			agentId: "claude",
			agentHandle: "fixer",
			spawnedBy: "a",
		});
		// The owner is written to the Tab row, not just held in memory.
		expect(tabUpdates).toContainEqual([
			t.id,
			expect.objectContaining({ spawnedByPane: "a" }),
		]);
		const s = useWorkspaceStore.getState();
		expect(s.activeTabByWorkspace.ws).toBe("t1");
		expect(s.focusedPaneId).toBe("a");
		expect(revealed).toEqual([]);
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
	it("opens a shell in a Spawned tab with the usual default name", async () => {
		const reply = await runRequest(caller, {
			op: "tab.new",
			name: null,
			focus: false,
		});
		const t = lastTab();
		expect(t).toMatchObject({ name: "Terminal 2", spawnedByPane: "a" });
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
				{ position: 2, spawnedByPane: "a" },
			),
			tab(
				"t4",
				{ type: "terminal", id: "d", ptyId: "pty-d", spawnedBy: "a" },
				{ position: 3, spawnedByPane: "a", userNamed: true },
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

	it("renames the caller's own Tab, not marking it user-named", async () => {
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

	it("refuses a Tab it did not open, and one the user named", async () => {
		await expect(rename("X", 2)).rejects.toMatchObject({ code: "not_owner" });
		await expect(rename("X", 4)).rejects.toMatchObject({
			code: "not_owner",
			message: expect.stringContaining("the user named this Tab"),
		});
		expect(nameOf("t2")).toBe("Tab t2");
		expect(nameOf("t4")).toBe("Tab t4");
	});
});

describe("tabRenameRefusal", () => {
	it("allows own and spawned Tabs, never user-named ones", () => {
		const r = (ownTab: boolean, spawnedByCaller: boolean, userNamed: boolean) =>
			tabRenameRefusal({ ownTab, spawnedByCaller, userNamed });
		expect(r(true, false, false)).toBeNull();
		expect(r(false, true, false)).toBeNull();
		expect(r(false, false, false)?.code).toBe("not_owner");
		expect(r(true, false, true)?.code).toBe("not_owner");
		expect(r(false, true, true)?.code).toBe("not_owner");
	});
});

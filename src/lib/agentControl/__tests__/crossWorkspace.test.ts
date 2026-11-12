import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pane numbers per Workspace, in the order first asked, never reused.
const numbering = new Map<string, Map<string, number>>();
const restoreOpened = vi.fn(async () => {});
vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: async (ws: string, ids: string[]) => {
			const m = numbering.get(ws) ?? new Map<string, number>();
			numbering.set(ws, m);
			return ids.map((id) => {
				if (!m.has(id)) m.set(id, m.size + 1);
				return [id, m.get(id)];
			});
		},
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent Two",
		paneClosed: async () => {},
	},
	tabs: {
		update: async () => {},
		create: async (workspaceId: string, name: string) => ({
			id: `new-tab-${workspaceId}`,
			workspaceId,
			name,
			layoutJson: JSON.stringify({
				type: "terminal",
				id: `new-pane-${workspaceId}`,
				ptyId: "",
			}),
			position: 9,
			createdAt: 0,
			updatedAt: 0,
		}),
	},
	workspaces: {
		setRestoreOpened: (...a: unknown[]) => restoreOpened(...(a as [])),
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
vi.mock("../../paneLocation", () => ({ revealPane: () => {} }));

import { useControlBadgeStore } from "../../../stores/controlBadgeStore";
import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../../types";
import { runRequest } from "../handleControlRequest";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "home" };
const there = { workspaceId: "api", open: false };

function ws(id: string, name: string, layout: PaneNode): WorkspaceWithTabs {
	const tab: Tab = {
		id: `t-${id}`,
		workspaceId: id,
		name: `Main ${name}`,
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	};
	return {
		id,
		name,
		rootFolder: `/src/${name}`,
		tabs: [tab],
	} as unknown as WorkspaceWithTabs;
}

function agentPty(ptyId: string) {
	usePtyActivityStore.setState((s) => ({
		activities: {
			...s.activities,
			[ptyId]: {
				state: "ready",
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
	numbering.clear();
	terminals.clear();
	restoreOpened.mockClear();
	terminals.set("a", { ptyId: "pty-a", term: { cols: 200, rows: 40 } });
	terminals.set("r", {
		ptyId: "pty-r",
		term: {
			rows: 24,
			buffer: {
				active: {
					length: 1,
					viewportY: 0,
					getLine: () => ({
						isWrapped: false,
						translateToString: () => "LGTM",
					}),
				},
			},
		},
	});
	useWorkspaceStore.setState({
		workspaces: [
			ws("home", "home", {
				type: "terminal",
				id: "a",
				ptyId: "pty-a",
				agentId: "claude",
				agentHandle: "Agent One",
			}),
			ws("api", "api", {
				type: "terminal",
				id: "r",
				ptyId: "pty-r",
				agentId: "codex",
				agentHandle: "Reviewer",
			}),
			ws("docs", "docs", {
				type: "terminal",
				id: "d",
				ptyId: "",
				agentId: "claude",
			}),
		],
		ptyStatuses: {},
		activeWorkspaceId: "home",
		activeTabByWorkspace: { home: "t-home", api: "t-api" },
		focusedPaneId: "a",
		focusedPaneByTab: {},
		missingFolderIds: new Set(),
	});
	usePtyActivityStore.setState({
		openedWorkspaceIds: new Set(["home", "api"]),
		activities: {},
	});
	agentPty("pty-a");
	agentPty("pty-r");
	useControlBadgeStore.setState({ badges: {} });
});

afterEach(() => vi.useRealTimers());

describe("calls into another Workspace", () => {
	it("lists that Workspace's Agents", async () => {
		const r = (await runRequest(
			caller,
			{ op: "agent.list" },
			undefined,
			there,
		)) as {
			agents: { handle: string; self: boolean }[];
		};
		expect(r.agents).toEqual([
			expect.objectContaining({ handle: "Reviewer", self: false }),
		]);
	});

	it("reads a pane there by handle, badged with the caller's Workspace", async () => {
		const seen: (string | undefined)[] = [];
		const unsub = useControlBadgeStore.subscribe((s) =>
			seen.push(s.badges.r?.by),
		);
		const r = await runRequest(
			caller,
			{
				op: "pane.read",
				target: { kind: "handle", value: "reviewer" },
				lines: null,
				visible: false,
			},
			undefined,
			there,
		);
		unsub();
		expect(r).toMatchObject({ pane: "p1", text: "LGTM" });
		expect(seen).toContain("Agent One · home");
	});

	it("pane current is still the caller's own pane", async () => {
		const r = await runRequest(
			caller,
			{ op: "pane.current" },
			undefined,
			there,
		);
		expect(r).toMatchObject({ handle: "Agent One", self: true });
	});

	it("never splits there: a new pane gets a Spawned tab owned by the caller", async () => {
		const r = await runRequest(
			caller,
			{ op: "pane.split", direction: null, focus: false },
			undefined,
			there,
		);
		const api = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === "api");
		expect(api?.tabs.map((t) => t.id)).toEqual(["t-api", "new-tab-api"]);
		const newTab = api?.tabs[1];
		expect(newTab?.spawnedByPane).toBe("a");
		// Its owner sits in another Workspace, so it is named with it.
		expect(r).toMatchObject({ spawnedBy: "p1 · home" });
		expect(r).not.toHaveProperty("hint");
		// The caller's own layout is untouched.
		const home = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === "home");
		expect(JSON.parse(home?.tabs[0].layoutJson ?? "{}").type).toBe("terminal");
	});

	it("tab rename there needs --tab: the caller has no Tab of its own there", async () => {
		await expect(
			runRequest(
				caller,
				{ op: "tab.rename", name: "X", target: null },
				undefined,
				there,
			),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			runRequest(
				caller,
				{ op: "tab.rename", name: "X", target: { kind: "pane", value: 1 } },
				undefined,
				there,
			),
		).rejects.toMatchObject({ code: "not_owner" });
	});
});

describe("a Workspace that is not Opened", () => {
	it("is opened in the background, then the call goes ahead", async () => {
		vi.useFakeTimers();
		const p = runRequest(caller, { op: "agent.list" }, undefined, {
			workspaceId: "docs",
			open: true,
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("docs")).toBe(
			true,
		);
		expect(restoreOpened).toHaveBeenCalledWith("docs", true);
		// Its terminals mount (TerminalPool does this for every Opened one).
		terminals.set("d", { ptyId: "pty-d", term: {} });
		await vi.advanceTimersByTimeAsync(500);
		await expect(p).resolves.toMatchObject({ agents: [] });
		// The user's view did not move.
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("home");
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("a");
	});

	it("stalls if its panes never load", async () => {
		vi.useFakeTimers();
		const p = runRequest(caller, { op: "agent.list" }, undefined, {
			workspaceId: "docs",
			open: true,
		});
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(31_000);
		await settled;
	});

	it("is refused when its folder is missing", async () => {
		useWorkspaceStore.setState({ missingFolderIds: new Set(["docs"]) });
		await expect(
			runRequest(caller, { op: "agent.list" }, undefined, {
				workspaceId: "docs",
				open: true,
			}),
		).rejects.toMatchObject({ code: "folder_missing" });
	});
});

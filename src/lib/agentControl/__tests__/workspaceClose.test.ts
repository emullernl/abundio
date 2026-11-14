import { beforeEach, describe, expect, it, vi } from "vitest";

const dirtyFileWindows = vi.fn(
	async (_ids: string[]): Promise<{ filePath: string; label: string }[]> => [],
);
const restoreOpened = vi.fn(async () => {});
vi.mock("../../ipc", () => ({
	agentControl: {
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent Two",
		paneClosed: async () => {},
	},
	fileWindows: {
		dirty: (ids: string[]) => dirtyFileWindows(ids),
		close: async () => {},
	},
	workspaces: {
		setRestoreOpened: (...a: unknown[]) => restoreOpened(...(a as [])),
	},
	tabs: { update: async () => {} },
	pty: { write: async () => {} },
	agentHooks: { ensure: async () => {} },
	shells: { default: async () => "/bin/zsh" },
}));
vi.mock("../../terminalManager", () => ({
	getTerminal: () => undefined,
	startPtyUnlessShown: () => () => {},
	teardownTerminal: () => {},
}));
vi.mock("../../paneLocation", () => ({ revealPane: () => {} }));

import { useExplorerStore } from "../../../stores/explorerStore";
import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { PaneNode, WorkspaceWithTabs } from "../../types";
import {
	addPtyBlocker,
	closeWorkspaceRefusal,
	noBlockers,
} from "../closeWorkspace";
import { runRequest } from "../handleControlRequest";
import { ControlError } from "../types";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "home" };
const api = { workspaceId: "api", open: false };
const close = (force = false) =>
	({ op: "workspace.close", name: "api", force }) as const;

function entry(over: Partial<PtyActivityEntry>): PtyActivityEntry {
	return {
		state: "ready",
		detectionMode: "agent",
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		hookDriven: true,
		shellCommandRunning: false,
		...over,
	} as PtyActivityEntry;
}

function ws(id: string, layout: PaneNode): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/src/${id}`,
		tabs: [
			{
				id: `t-${id}`,
				workspaceId: id,
				name: "Main",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

function setActivity(ptyId: string, e: Partial<PtyActivityEntry>) {
	usePtyActivityStore.setState((s) => ({
		activities: { ...s.activities, [ptyId]: entry(e) },
	}));
}

beforeEach(() => {
	dirtyFileWindows.mockReset();
	dirtyFileWindows.mockResolvedValue([]);
	useWorkspaceStore.setState({
		workspaces: [
			ws("home", {
				type: "terminal",
				id: "a",
				ptyId: "pty-a",
				agentId: "claude",
			}),
			ws("api", {
				type: "split",
				id: "s",
				direction: "horizontal",
				ratio: 0.5,
				first: {
					type: "terminal",
					id: "r",
					ptyId: "pty-r",
					agentId: "codex",
					agentHandle: "Reviewer",
				},
				second: { type: "terminal", id: "sh", ptyId: "pty-sh" },
			} as PaneNode),
		],
		ptyStatuses: {},
		activeWorkspaceId: "home",
		focusedPaneId: "a",
		missingFolderIds: new Set(),
	});
	usePtyActivityStore.setState({
		openedWorkspaceIds: new Set(["home", "api"]),
		activities: {},
		panePtyMap: {},
	});
	setActivity("pty-a", {});
	setActivity("pty-r", {});
	setActivity("pty-sh", { detectionMode: "shell", state: "idle" });
	useExplorerStore.setState({ filePanes: {} });
});

describe("closeWorkspaceRefusal", () => {
	const none = noBlockers;

	it("lets a quiet Workspace close", () => {
		expect(closeWorkspaceRefusal("api", none(), false)).toBeNull();
	});

	it("refuses live work unless forced", () => {
		for (const key of ["working", "waiting", "commands"] as const) {
			const b = { ...none(), [key]: ["p1"] };
			expect(closeWorkspaceRefusal("api", b, false)?.code).toBe("busy");
			expect(closeWorkspaceRefusal("api", b, true)).toBeNull();
		}
	});

	it("refuses unsaved edits even when forced", () => {
		const b = { ...none(), working: ["p1"], unsaved: ["a.ts"] };
		const r = closeWorkspaceRefusal("api", b, true);
		expect(r?.code).toBe("unsaved");
		expect(r?.message).toContain("a.ts");
	});

	it("sorts PTYs: Working, Waiting, running command, quiet", () => {
		const b = none();
		addPtyBlocker(b, "w", entry({ state: "active" }));
		addPtyBlocker(b, "q", entry({ state: "waiting" }));
		addPtyBlocker(b, "r", entry({ state: "ready" }));
		addPtyBlocker(
			b,
			"c",
			entry({ detectionMode: "shell", shellCommandRunning: true }),
		);
		addPtyBlocker(b, "i", entry({ detectionMode: "shell" }));
		addPtyBlocker(b, "none", undefined);
		expect(b).toEqual({
			working: ["w"],
			waiting: ["q"],
			commands: ["c"],
			unsaved: [],
		});
	});
});

describe("workspace close", () => {
	it("closes a quiet Workspace and forgets it, keeping its row", async () => {
		const r = await runRequest(caller, close(), undefined, api);
		expect(r).toEqual({ workspace: "api", closed: true });
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("api")).toBe(
			false,
		);
		expect(
			useWorkspaceStore.getState().workspaces.some((w) => w.id === "api"),
		).toBe(true);
	});

	it("never closes the caller's own Workspace", async () => {
		await expect(
			runRequest(caller, { ...close(), name: "home" }, undefined, {
				workspaceId: "home",
				open: false,
			}),
		).rejects.toMatchObject({ code: "own_workspace" });
		await expect(runRequest(caller, close())).rejects.toBeInstanceOf(
			ControlError,
		);
	});

	it("answers 'already closed' for a Workspace that is not Opened, without opening it", async () => {
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["home"]) });
		const r = await runRequest(caller, close(), undefined, api);
		expect(r).toEqual({ workspace: "api", closed: true, alreadyClosed: true });
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("api")).toBe(
			false,
		);
	});

	it("refuses a Waiting Agent unless forced, naming it", async () => {
		setActivity("pty-r", { state: "waiting" });
		await expect(
			runRequest(caller, close(), undefined, api),
		).rejects.toMatchObject({
			code: "busy",
			message: expect.stringContaining("p1 Reviewer"),
		});
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("api")).toBe(
			true,
		);
		await expect(
			runRequest(caller, close(true), undefined, api),
		).resolves.toEqual({ workspace: "api", closed: true });
	});

	it("refuses a running command unless forced", async () => {
		setActivity("pty-sh", {
			detectionMode: "shell",
			shellCommandRunning: true,
		});
		await expect(
			runRequest(caller, close(), undefined, api),
		).rejects.toMatchObject({ code: "busy" });
	});

	it("refuses unsaved edits in a File window even with --force", async () => {
		dirtyFileWindows.mockResolvedValue([
			{ filePath: "/src/api/README.md", label: "md-1" },
		]);
		await expect(
			runRequest(caller, close(true), undefined, api),
		).rejects.toMatchObject({
			code: "unsaved",
			message: expect.stringContaining("README.md"),
		});
		expect(dirtyFileWindows).toHaveBeenCalledWith(["api"]);
	});

	it("sees an Agent that starts a turn while the checks are awaited", async () => {
		dirtyFileWindows.mockImplementation(async () => {
			setActivity("pty-r", { state: "active" });
			return [];
		});
		await expect(
			runRequest(caller, close(), undefined, api),
		).rejects.toMatchObject({ code: "busy" });
	});

	it("refuses when File windows cannot be checked", async () => {
		dirtyFileWindows.mockRejectedValue(new Error("ipc down"));
		await expect(
			runRequest(caller, close(true), undefined, api),
		).rejects.toMatchObject({ code: "state_unknown" });
	});
});

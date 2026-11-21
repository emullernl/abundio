import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = (id: string, ptyId = "") => ({
	id,
	name: id,
	rootFolder: `/home/dev/${id}`,
	agentPresetsJson: "{}",
	fileTabsJson: "{}",
	baseBranch: null,
	lastBranch: null,
	position: 0,
	profileId: "remote-p",
	createdAt: 0,
	updatedAt: 0,
	worktreeSetupCommands: "",
	tabs: [
		{
			id: `t-${id}`,
			workspaceId: id,
			name: "Tab",
			layoutJson: JSON.stringify({ type: "terminal", id: `p-${id}`, ptyId }),
			position: 0,
			createdAt: 0,
			updatedAt: 0,
		},
	],
});

vi.mock("../../lib/ipc", () => ({
	joinedApi: {
		list: vi.fn(),
		add: vi.fn(() => Promise.resolve()),
		remove: vi.fn(() => Promise.resolve()),
		seen: vi.fn(() => Promise.resolve()),
		join: vi.fn(() => Promise.resolve()),
		callOn: vi.fn(),
	},
	hostsApi: {
		list: vi.fn(() => Promise.resolve([{ id: "box", name: "Build box" }])),
	},
	listenToThisWindow: vi.fn(() => Promise.resolve(() => {})),
	fileWindows: { close: vi.fn(() => Promise.resolve()) },
	workspaces: { list: vi.fn(() => Promise.resolve([])) },
	tabs: {},
	pty: {
		kill: vi.fn(() => Promise.resolve()),
		deleteLog: vi.fn(() => Promise.resolve()),
	},
}));

import { joinedHostOfWorkspace, resetRouting } from "../../lib/hostRouting";
import { joinedApi } from "../../lib/ipc";
import { needsSignIn, useJoinedStore } from "../joinedStore";
import { useWorkspaceStore } from "../workspaceStore";

const joinedIds = () =>
	useWorkspaceStore
		.getState()
		.workspaces.filter((w) => w.joined?.hostId === "box")
		.map((w) => w.id);

describe("joinedStore (phase 10)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetRouting();
		useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
		useJoinedStore.setState({ entries: [], links: {} });
	});

	it("shows the rows the Host last listed, then its own, reattaching to live panes", async () => {
		vi.mocked(joinedApi.list).mockResolvedValue([
			{
				hostId: "box",
				remoteProfileId: "remote-p",
				remoteProfileName: "Build",
				workspacesJson: JSON.stringify([
					workspace("old", "gone-pty"),
					workspace("app", "live-pty"),
				]),
				lastSeenMs: 1,
			},
		]);
		let answer!: (v: unknown) => void;
		vi.mocked(joinedApi.callOn).mockImplementation((_h, command) =>
			command === "workspace_list"
				? new Promise((r) => {
						answer = r;
					})
				: Promise.resolve(["live-pty"]),
		);
		await useJoinedStore.getState().loadJoined();
		// Cached, while the Host has not answered: no PTY id kept.
		expect(joinedIds()).toEqual(["old", "app"]);
		const cached = useWorkspaceStore.getState().workspaces[0];
		expect(JSON.parse(cached.tabs[0].layoutJson).ptyId).toBe("");
		expect(useJoinedStore.getState().links.box).toEqual({
			state: "connecting",
		});
		answer([workspace("app", "live-pty")]);
		await vi.waitFor(() =>
			expect(useJoinedStore.getState().links.box).toEqual({ state: "online" }),
		);
		expect(joinedIds()).toEqual(["app"]);
		const live = useWorkspaceStore.getState().workspaces[0];
		expect(JSON.parse(live.tabs[0].layoutJson).ptyId).toBe("live-pty");
		expect(joinedHostOfWorkspace("app")).toBe("box");
		expect(joinedApi.seen).toHaveBeenCalled();
	});

	it("says Sign in needed when ssh wants the user, and Leave removes the section", async () => {
		vi.mocked(joinedApi.list).mockResolvedValue([
			{
				hostId: "box",
				remoteProfileId: "remote-p",
				remoteProfileName: "Build",
				workspacesJson: JSON.stringify([workspace("old")]),
				lastSeenMs: null,
			},
		]);
		vi.mocked(joinedApi.join).mockRejectedValue(
			"dev@box: Permission denied (publickey,password).",
		);
		await useJoinedStore.getState().loadJoined();
		await vi.waitFor(() =>
			expect(useJoinedStore.getState().links.box).toMatchObject({
				state: "offline",
				signIn: true,
			}),
		);
		await useJoinedStore.getState().leave("box");
		expect(joinedApi.remove).toHaveBeenCalledWith(expect.any(String), "box");
		expect(joinedIds()).toEqual([]);
		expect(useJoinedStore.getState().entries).toEqual([]);
		expect(joinedHostOfWorkspace("old")).toBeNull();
	});

	it("knows which failures need the user", () => {
		expect(needsSignIn("Host key verification failed.")).toBe(true);
		expect(
			needsSignIn("ssh: connect to host box port 22: Operation timed out"),
		).toBe(false);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useGitChangesStore } from "../gitChangesStore";
import { useWorkspaceGitStore } from "../workspaceGitStore";
import { useWorkspaceStore } from "../workspaceStore";

vi.mock("../../lib/ipc", () => ({
	git: {
		workspacesSummary: vi.fn(),
	},
	workspaces: {
		update: vi.fn().mockResolvedValue(undefined),
	},
	worktrees: {},
	pty: {},
	tabs: {},
}));

import { git } from "../../lib/ipc";

function mkWorkspace(id: string, rootFolder: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder,
		agentPresetsJson: "[]",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [],
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal bundle stub
const bundle = (): any => ({
	changedFiles: [],
	branchInfo: { currentBranch: "main", defaultBranch: "main" },
	statusFingerprint: "fp",
});

// biome-ignore lint/suspicious/noExplicitAny: partial summary stub
const summary = (over: Record<string, unknown>): any => ({
	workspaceId: "ws-1",
	isGitRepo: true,
	currentBranch: "main",
	changedFileCount: 0,
	additions: 0,
	deletions: 0,
	worktreeGroupKey: "/repo/.git",
	isMainWorktree: true,
	worktreeRoot: "/repo",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	useWorkspaceStore.setState({
		workspaces: [mkWorkspace("ws-1", "/repo")],
		activeWorkspaceId: "ws-1",
	});
	useWorkspaceGitStore.setState({
		byWorkspaceId: {},
		worktreeFacts: {},
		inFlight: new Set(),
	});
});

describe("gitChangesStore git-repo transition → worktree facts", () => {
	it("applyBundle refreshes worktree facts when the folder just became a repo (git init mid-session)", async () => {
		// No worktree facts yet — the folder wasn't a git repo when it opened.
		vi.mocked(git.workspacesSummary).mockResolvedValue([summary({})]);

		useGitChangesStore.getState().applyBundle("ws-1", bundle());
		// syncWorktreeFacts is fire-and-forget inside applyBundle; let it settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(git.workspacesSummary).toHaveBeenCalledTimes(1);
		const facts = useWorkspaceGitStore.getState().worktreeFacts["ws-1"];
		expect(facts?.isMainWorktree).toBe(true);
		expect(facts?.worktreeGroupKey).toBe("/repo/.git");
	});

	it("applyBundle does NOT re-sync worktree facts once a group key is already known", async () => {
		useWorkspaceGitStore.setState({
			worktreeFacts: {
				"ws-1": {
					worktreeGroupKey: "/repo/.git",
					isMainWorktree: true,
					worktreeRoot: "/repo",
				},
			},
		});

		useGitChangesStore.getState().applyBundle("ws-1", bundle());
		await Promise.resolve();
		await Promise.resolve();

		expect(git.workspacesSummary).not.toHaveBeenCalled();
	});

	it("applyError(notGitRepo) drops stale worktree facts when a repo's .git disappears", async () => {
		useWorkspaceGitStore.setState({
			worktreeFacts: {
				"ws-1": {
					worktreeGroupKey: "/repo/.git",
					isMainWorktree: true,
					worktreeRoot: "/repo",
				},
			},
		});
		// The folder is no longer a repo — summary now reports no group key.
		vi.mocked(git.workspacesSummary).mockResolvedValue([
			summary({
				isGitRepo: false,
				worktreeGroupKey: null,
				isMainWorktree: false,
				worktreeRoot: null,
			}),
		]);

		useGitChangesStore
			.getState()
			.applyError("ws-1", "Not a git repository", true);
		await Promise.resolve();
		await Promise.resolve();

		expect(git.workspacesSummary).toHaveBeenCalledTimes(1);
		const facts = useWorkspaceGitStore.getState().worktreeFacts["ws-1"];
		expect(facts?.worktreeGroupKey).toBeNull();
		expect(facts?.isMainWorktree).toBe(false);
	});

	it("applyError(notGitRepo) does nothing extra when no worktree facts were held", async () => {
		useGitChangesStore
			.getState()
			.applyError("ws-1", "Not a git repository", true);
		await Promise.resolve();
		await Promise.resolve();

		expect(git.workspacesSummary).not.toHaveBeenCalled();
	});
});

// biome-ignore lint/suspicious/noExplicitAny: minimal changed-file stub
const file = (path: string, section: string, status = "M"): any => ({
	path,
	section,
	status,
	additions: 0,
	deletions: 0,
});

describe("conflicted paths and operation state", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [mkWorkspace("ws-1", "/repo"), mkWorkspace("ws-2", "/other")],
			activeWorkspaceId: "ws-1",
			// biome-ignore lint/suspicious/noExplicitAny: partial store
		} as any);
		useWorkspaceGitStore.setState({ byWorkspaceId: {} });
	});

	it("writes conflictedPaths for a background workspace", () => {
		// The pane reads its own workspace's truth: background workspaces stay
		// mounted (ADR-0002), so this must be populated even when ws-2 is not
		// the active workspace.
		useGitChangesStore.getState().applyBundle("ws-2", {
			...bundle(),
			changedFiles: [file("a.txt", "conflicted", "U"), file("b.txt", "staged")],
		});

		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-2"]?.conflictedPaths,
		).toEqual(["a.txt"]);
		// ...and the singleton, which mirrors the *active* workspace, is untouched.
		expect(useGitChangesStore.getState().changedFiles).toEqual([]);
	});

	it("clears conflictedPaths once the conflict is resolved", () => {
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "conflicted", "U")],
		});
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.conflictedPaths,
		).toEqual(["a.txt"]);

		store.applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "staged")],
		});
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.conflictedPaths,
		).toEqual([]);
	});

	it("re-renders when a file only changes section", () => {
		// Pins the `filesEqual` field list: it must keep comparing `section`, or
		// unstaged -> conflicted -> staged would not repaint the tab.
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "unstaged")],
		});
		store.applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "conflicted", "U")],
		});
		expect(useGitChangesStore.getState().changedFiles[0]?.section).toBe(
			"conflicted",
		);
	});

	it("carries operationInProgress onto the active workspace", () => {
		useGitChangesStore.getState().applyBundle("ws-1", {
			...bundle(),
			operationInProgress: "rebase",
		});
		expect(useGitChangesStore.getState().operationInProgress).toBe("rebase");

		useGitChangesStore.getState().applyBundle("ws-1", {
			...bundle(),
			operationInProgress: null,
		});
		expect(useGitChangesStore.getState().operationInProgress).toBeNull();
	});

	it("hydrates operationInProgress when switching back to a workspace", () => {
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-1", { ...bundle(), operationInProgress: "merge" });
		store.clear();
		expect(useGitChangesStore.getState().operationInProgress).toBeNull();
		store.hydrateFromWorkspace("ws-1");
		expect(useGitChangesStore.getState().operationInProgress).toBe("merge");
	});
});

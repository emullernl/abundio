import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import { branchCommitsEqual, useGitChangesStore } from "../gitChangesStore";
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

describe("conflictedPaths distinguishes unknown from empty", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [mkWorkspace("ws-1", "/repo")],
			activeWorkspaceId: "ws-1",
			// biome-ignore lint/suspicious/noExplicitAny: partial store
		} as any);
		useWorkspaceGitStore.setState({ byWorkspaceId: {} });
	});

	it("is null before git has answered", () => {
		// The load-bearing case: an empty array would read as "no conflicts" and
		// tear down a Merge view restored from the persisted layout, then persist
		// the stripped layout — so it would not come back.
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.conflictedPaths,
		).toBeUndefined();
	});

	it("is an empty array once git answers with no conflicts", () => {
		useGitChangesStore.getState().applyBundle("ws-1", bundle());
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.conflictedPaths,
		).toEqual([]);
	});

	it("does not overwrite a real answer with null on a summary refresh", async () => {
		useGitChangesStore.getState().applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "conflicted", "U")],
		});
		// biome-ignore lint/suspicious/noExplicitAny: mocked ipc
		(git.workspacesSummary as any).mockResolvedValue([
			summary({ workspaceId: "ws-1" }),
		]);
		await useWorkspaceGitStore
			.getState()
			.fetchAll([{ id: "ws-1", rootFolder: "/repo", baseBranch: null }]);

		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.conflictedPaths,
		).toEqual(["a.txt"]);
	});
});

describe("Dirty workspace and Branch stat from bundles", () => {
	beforeEach(() => {
		useWorkspaceGitStore.setState({ byWorkspaceId: {}, uncommittedById: {} });
	});

	it("applyBundle records a live dirtiness value for a background workspace", () => {
		useWorkspaceStore.setState({
			workspaces: [mkWorkspace("ws-1", "/repo"), mkWorkspace("ws-2", "/other")],
			activeWorkspaceId: "ws-1",
		});
		useGitChangesStore.getState().applyBundle("ws-2", {
			...bundle(),
			changedFiles: [file("a.txt", "staged"), file("b.txt", "untracked", "?")],
		});
		expect(useWorkspaceGitStore.getState().uncommittedById["ws-2"]).toEqual({
			dirty: true,
			breakdown: { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 },
		});
	});

	it("applyBundle counts a path in two sections as one file", () => {
		useGitChangesStore.getState().applyBundle("ws-1", {
			...bundle(),
			changedFiles: [file("a.txt", "against_base"), file("a.txt", "unstaged")],
		});
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-1"]?.changedFileCount,
		).toBe(1);
	});

	it("applyError(notGitRepo) forgets dirtiness", () => {
		useWorkspaceGitStore
			.getState()
			.setLiveUncommitted("ws-1", [file("a.txt", "staged")]);
		useGitChangesStore
			.getState()
			.applyError("ws-1", "Not a git repository", true);
		expect(
			useWorkspaceGitStore.getState().uncommittedById["ws-1"],
		).toBeUndefined();
	});
});

describe("Branch commits from bundles", () => {
	const commit = (oid: string, onRemote = false) => ({
		oid,
		subject: oid,
		message: oid,
		authorName: "T",
		authorEmail: "t@example.com",
		time: 0,
		isMerge: false,
		onRemote,
	});
	const commits = (...cs: ReturnType<typeof commit>[]) => ({
		base: "main",
		total: cs.length,
		commits: cs,
	});

	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [mkWorkspace("ws-1", "/repo"), mkWorkspace("ws-2", "/b")],
			activeWorkspaceId: "ws-1",
			// biome-ignore lint/suspicious/noExplicitAny: partial store
		} as any);
		useGitChangesStore.getState().clear();
	});

	it("carries branchCommits onto the active workspace", () => {
		const bc = commits(commit("a"), commit("b"));
		useGitChangesStore
			.getState()
			.applyBundle("ws-1", { ...bundle(), branchCommits: bc });
		expect(useGitChangesStore.getState().branchCommits).toEqual(bc);
	});

	it("keeps the same object when nothing about the list moved", () => {
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-1", {
			...bundle(),
			branchCommits: commits(commit("a")),
		});
		const first = useGitChangesStore.getState().branchCommits;
		store.applyBundle("ws-1", {
			...bundle(),
			branchCommits: commits(commit("a")),
		});
		expect(useGitChangesStore.getState().branchCommits).toBe(first);
		// A push is a change, even with the same oids.
		store.applyBundle("ws-1", {
			...bundle(),
			branchCommits: commits(commit("a", true)),
		});
		expect(useGitChangesStore.getState().branchCommits).not.toBe(first);
	});

	it("does not show a background workspace's commits, but hydrates them", () => {
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-2", {
			...bundle(),
			branchCommits: commits(commit("z")),
		});
		expect(useGitChangesStore.getState().branchCommits).toBeNull();
		store.hydrateFromWorkspace("ws-2");
		expect(useGitChangesStore.getState().branchCommits?.commits[0].oid).toBe(
			"z",
		);
	});

	it("drops the list when the refresh fails, in the cache too", () => {
		const store = useGitChangesStore.getState();
		store.applyBundle("ws-1", {
			...bundle(),
			branchCommits: commits(commit("a")),
		});
		store.applyError("ws-1", "boom", false);
		expect(useGitChangesStore.getState().branchCommits).toBeNull();
		store.hydrateFromWorkspace("ws-1");
		expect(useGitChangesStore.getState().branchCommits).toBeNull();
	});
});

describe("branchCommitsEqual", () => {
	it("treats two nulls as equal and null vs a list as different", () => {
		expect(branchCommitsEqual(null, null)).toBe(true);
		expect(branchCommitsEqual(null, { base: "m", total: 0, commits: [] })).toBe(
			false,
		);
	});
	it("notices a base or total change", () => {
		const a = { base: "main", total: 0, commits: [] };
		expect(branchCommitsEqual(a, { ...a, base: "dev" })).toBe(false);
		expect(branchCommitsEqual(a, { ...a, total: 300 })).toBe(false);
	});
});

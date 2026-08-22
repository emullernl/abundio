import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	profileRepoSlugs,
	repoSlugsResolvedFor,
	useWorkspaceGitStore,
} from "../workspaceGitStore";

vi.mock("../../lib/ipc", () => ({
	git: {
		branchInfo: vi.fn(),
		changedFiles: vi.fn(),
		workspacesSummary: vi.fn(),
	},
	workspaces: {
		update: vi.fn().mockResolvedValue(undefined),
	},
}));

import { git } from "../../lib/ipc";

// biome-ignore lint/suspicious/noExplicitAny: mock data
const noFiles = () => Promise.resolve([] as any[]);
const twoFiles = () =>
	Promise.resolve([
		{
			path: "a.ts",
			status: "M",
			additions: 10,
			deletions: 3,
			section: "staged",
		},
		{
			path: "b.ts",
			status: "M",
			additions: 5,
			deletions: 1,
			section: "unstaged",
		},
		// biome-ignore lint/suspicious/noExplicitAny: mock data
	] as any[]);

function resetStore() {
	useWorkspaceGitStore.setState({
		byWorkspaceId: {},
		repoSlugsById: {},
		inFlight: new Set(),
	});
}

const baseInfo = {
	isGitRepo: true as const,
	currentBranch: "main",
	changedFileCount: 0,
	conflictedPaths: [],
	additions: 0,
	deletions: 0,
};

beforeEach(() => {
	resetStore();
	vi.clearAllMocks();
});

describe("workspaceGitStore", () => {
	it("fetch: success stores isGitRepo=true, branch, and change stats", async () => {
		vi.mocked(git.branchInfo).mockResolvedValue({
			currentBranch: "main",
			defaultBranch: "main",
		});
		vi.mocked(git.changedFiles).mockImplementation(twoFiles);
		await useWorkspaceGitStore.getState().fetch("ws-1", "/repo");
		const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-1"];
		expect(info).toEqual({
			isGitRepo: true,
			currentBranch: "main",
			changedFileCount: 2,
			conflictedPaths: [],
			additions: 15,
			deletions: 4,
		});
	});

	it("fetch: no changed files stores zero stats", async () => {
		vi.mocked(git.branchInfo).mockResolvedValue({
			currentBranch: "main",
			defaultBranch: "main",
		});
		vi.mocked(git.changedFiles).mockImplementation(noFiles);
		await useWorkspaceGitStore.getState().fetch("ws-clean", "/repo");
		const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-clean"];
		expect(info?.changedFileCount).toBe(0);
		expect(info?.additions).toBe(0);
		expect(info?.deletions).toBe(0);
	});

	it("fetch: 'Not a git repository' error stores isGitRepo=false", async () => {
		vi.mocked(git.branchInfo).mockRejectedValue(
			new Error("Not a git repository: /tmp"),
		);
		vi.mocked(git.changedFiles).mockImplementation(noFiles);
		await useWorkspaceGitStore.getState().fetch("ws-2", "/tmp");
		const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-2"];
		expect(info).toEqual({
			isGitRepo: false,
			currentBranch: null,
			changedFileCount: 0,
			conflictedPaths: [],
			additions: 0,
			deletions: 0,
		});
	});

	it("fetch: case-insensitive match for 'not a git repository'", async () => {
		vi.mocked(git.branchInfo).mockRejectedValue(
			new Error("not a git repository: /some/path"),
		);
		vi.mocked(git.changedFiles).mockImplementation(noFiles);
		await useWorkspaceGitStore.getState().fetch("ws-ci", "/some/path");
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-ci"]?.isGitRepo,
		).toBe(false);
	});

	it("fetch: other error leaves existing entry untouched", async () => {
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				"ws-3": {
					isGitRepo: true,
					currentBranch: "feat",
					changedFileCount: 1,
					conflictedPaths: [],
					additions: 5,
					deletions: 2,
				},
			},
			inFlight: new Set(),
		});
		vi.mocked(git.branchInfo).mockRejectedValue(new Error("git not found"));
		vi.mocked(git.changedFiles).mockImplementation(noFiles);
		await useWorkspaceGitStore.getState().fetch("ws-3", "/repo");
		const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-3"];
		expect(info?.currentBranch).toBe("feat");
		expect(info?.changedFileCount).toBe(1);
	});

	it("fetch: clears inFlight when done", async () => {
		vi.mocked(git.branchInfo).mockResolvedValue({
			currentBranch: "main",
			defaultBranch: "main",
		});
		vi.mocked(git.changedFiles).mockImplementation(noFiles);
		await useWorkspaceGitStore.getState().fetch("ws-4", "/repo");
		expect(useWorkspaceGitStore.getState().inFlight.has("ws-4")).toBe(false);
	});

	it("fetchAll stores info for all workspaces via batch command", async () => {
		vi.mocked(git.workspacesSummary).mockResolvedValue([
			{
				workspaceId: "ws-a",
				isGitRepo: true,
				currentBranch: "main",
				changedFileCount: 0,
				additions: 0,
				deletions: 0,
				worktreeGroupKey: "/a/.git",
				isMainWorktree: true,
				worktreeRoot: "/a",
				repoSlugs: ["org/a"],
			},
			{
				workspaceId: "ws-b",
				isGitRepo: true,
				currentBranch: "dev",
				changedFileCount: 2,
				additions: 10,
				deletions: 3,
				worktreeGroupKey: "/b/.git",
				isMainWorktree: true,
				worktreeRoot: "/b",
				repoSlugs: ["org/b"],
			},
		]);
		await useWorkspaceGitStore.getState().fetchAll([
			{ id: "ws-a", rootFolder: "/a" },
			{ id: "ws-b", rootFolder: "/b" },
		]);
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-a"]?.currentBranch,
		).toBe("main");
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-b"]?.currentBranch,
		).toBe("dev");
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-b"]?.changedFileCount,
		).toBe(2);
	});

	describe("repo slugs (Profile-scoped PR filter, ADR-0028)", () => {
		const summary = (
			workspaceId: string,
			root: string,
			repoSlugs: string[],
			// biome-ignore lint/suspicious/noExplicitAny: mock data
		): any => ({
			workspaceId,
			isGitRepo: true,
			currentBranch: "main",
			changedFileCount: 0,
			conflictedPaths: [],
			additions: 0,
			deletions: 0,
			worktreeGroupKey: `${root}/.git`,
			isMainWorktree: true,
			worktreeRoot: root,
			repoSlugs,
		});

		it("syncWorktreeFacts records slugs per workspace", async () => {
			vi.mocked(git.workspacesSummary).mockResolvedValue([
				summary("ws-a", "/a", ["me/a", "acme/a"]),
				summary("ws-b", "/b", []),
			]);
			expect(useWorkspaceGitStore.getState().repoSlugsById).toEqual({});

			await useWorkspaceGitStore.getState().syncWorktreeFacts([
				{ id: "ws-a", rootFolder: "/a" },
				{ id: "ws-b", rootFolder: "/b" },
			]);

			const s = useWorkspaceGitStore.getState();
			expect(s.repoSlugsById["ws-a"]).toEqual(["me/a", "acme/a"]);
			expect(s.repoSlugsById["ws-b"]).toEqual([]);
		});

		it("fetchAll records slugs too", async () => {
			vi.mocked(git.workspacesSummary).mockResolvedValue([
				summary("ws-c", "/c", ["org/c"]),
			]);
			await useWorkspaceGitStore
				.getState()
				.fetchAll([{ id: "ws-c", rootFolder: "/c" }]);
			expect(useWorkspaceGitStore.getState().repoSlugsById["ws-c"]).toEqual([
				"org/c",
			]);
		});

		it("records an empty answer for unanswered workspaces when the IPC fails", async () => {
			// A missing entry reads as "still resolving" in the PR section, so a
			// failed batch must still answer for the workspaces it asked about —
			// otherwise the panel hangs on "Loading repositories…" forever.
			vi.mocked(git.workspacesSummary).mockRejectedValue(new Error("boom"));
			await useWorkspaceGitStore
				.getState()
				.syncWorktreeFacts([{ id: "ws-e", rootFolder: "/e" }]);
			expect(useWorkspaceGitStore.getState().repoSlugsById["ws-e"]).toEqual([]);
		});

		it("keeps known slugs when a later sync fails", async () => {
			// A transient rejection must not turn a correct set into a confident
			// empty one — that reads as "this profile has no GitHub repositories".
			vi.mocked(git.workspacesSummary).mockResolvedValue([
				summary("ws-f", "/f", ["org/f"]),
			]);
			await useWorkspaceGitStore
				.getState()
				.syncWorktreeFacts([{ id: "ws-f", rootFolder: "/f" }]);

			vi.mocked(git.workspacesSummary).mockRejectedValue(new Error("boom"));
			await useWorkspaceGitStore
				.getState()
				.syncWorktreeFacts([{ id: "ws-f", rootFolder: "/f" }]);

			expect(useWorkspaceGitStore.getState().repoSlugsById["ws-f"]).toEqual([
				"org/f",
			]);
		});

		it("answers for every requested workspace, not just the summarised ones", async () => {
			// git_workspaces_summary ends in unwrap_or_default(), so a panic in the
			// blocking task resolves to a short list instead of rejecting. Keying
			// the write off the response would leave ws-h permanently unresolved.
			vi.mocked(git.workspacesSummary).mockResolvedValue([
				summary("ws-g", "/g", ["org/g"]),
			]);
			await useWorkspaceGitStore.getState().syncWorktreeFacts([
				{ id: "ws-g", rootFolder: "/g" },
				{ id: "ws-h", rootFolder: "/h" },
			]);

			const s = useWorkspaceGitStore.getState();
			expect(s.repoSlugsById["ws-g"]).toEqual(["org/g"]);
			expect(s.repoSlugsById["ws-h"]).toEqual([]);
			expect(
				repoSlugsResolvedFor(
					[{ id: "ws-g" }, { id: "ws-h" }],
					s.repoSlugsById,
					true,
				),
			).toBe(true);
		});

		it("remove drops the workspace's slugs", () => {
			useWorkspaceGitStore.setState({ repoSlugsById: { "ws-d": ["org/d"] } });
			useWorkspaceGitStore.getState().remove("ws-d");
			expect(
				useWorkspaceGitStore.getState().repoSlugsById["ws-d"],
			).toBeUndefined();
		});

		it("profileRepoSlugs unions the listed workspaces' slugs", () => {
			// Two worktrees of one repo collapse to a single entry; a fork
			// Workspace contributes both of its remotes.
			expect(
				profileRepoSlugs([{ id: "ws-a" }, { id: "ws-b" }, { id: "ws-c" }], {
					"ws-a": ["me/a", "acme/a"],
					"ws-b": ["me/a"],
					"ws-c": [],
				}),
			).toEqual(new Set(["me/a", "acme/a"]));
		});

		it("ignores slugs of workspaces outside the given list", () => {
			// Switching Profile reloads the workspace list but leaves the previous
			// profile's entries in the map — they must not widen the filter.
			expect(
				profileRepoSlugs([{ id: "ws-a" }], {
					"ws-a": ["org/a"],
					"ws-other-profile": ["org/secret"],
				}),
			).toEqual(new Set(["org/a"]));
		});

		it("returns an empty set when nothing resolves", () => {
			expect(profileRepoSlugs([{ id: "ws-a" }], {})).toEqual(new Set());
		});

		describe("repoSlugsResolvedFor", () => {
			it("is false until the workspace list itself has loaded", () => {
				// Otherwise the pre-load empty list would read as "this profile has
				// no repositories" on every launch.
				expect(repoSlugsResolvedFor([], {}, false)).toBe(false);
			});

			it("is true vacuously for a profile with no workspaces", () => {
				// Nothing triggers a summary here, so anything else hangs forever.
				expect(repoSlugsResolvedFor([], {}, true)).toBe(true);
			});

			it("is false while any listed workspace is unanswered", () => {
				// The profile-switch case: the new profile's workspaces aren't in the
				// map yet, even though the previous profile's summary succeeded.
				expect(
					repoSlugsResolvedFor(
						[{ id: "ws-a" }, { id: "ws-b" }],
						{ "ws-a": ["org/a"], "ws-old": ["org/old"] },
						true,
					),
				).toBe(false);
			});

			it("is true once every listed workspace has an answer, including none", () => {
				expect(
					repoSlugsResolvedFor(
						[{ id: "ws-a" }, { id: "ws-b" }],
						{ "ws-a": ["org/a"], "ws-b": [] },
						true,
					),
				).toBe(true);
			});
		});
	});

	it("setInfo updates entry directly", () => {
		useWorkspaceGitStore.getState().setInfo("ws-x", {
			isGitRepo: true,
			currentBranch: "feature/test",
			changedFileCount: 3,
			conflictedPaths: [],
			additions: 20,
			deletions: 5,
		});
		expect(useWorkspaceGitStore.getState().byWorkspaceId["ws-x"]).toEqual({
			isGitRepo: true,
			currentBranch: "feature/test",
			changedFileCount: 3,
			conflictedPaths: [],
			additions: 20,
			deletions: 5,
		});
	});

	it("remove deletes entry", () => {
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				"ws-y": {
					isGitRepo: true,
					currentBranch: "main",
					changedFileCount: 0,
					conflictedPaths: [],
					additions: 0,
					deletions: 0,
				},
			},
			inFlight: new Set(),
		});
		useWorkspaceGitStore.getState().remove("ws-y");
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-y"],
		).toBeUndefined();
	});

	describe("refreshWorkspace", () => {
		it("updates counts on every call", async () => {
			useWorkspaceGitStore.setState({
				byWorkspaceId: { "ws-rw1": { ...baseInfo } },
				inFlight: new Set(),
			});
			vi.mocked(git.changedFiles).mockImplementation(twoFiles);
			await useWorkspaceGitStore.getState().refreshWorkspace("ws-rw1", "/repo");
			const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-rw1"];
			expect(info?.changedFileCount).toBe(2);
			expect(info?.additions).toBe(15);
			expect(info?.deletions).toBe(4);
		});

		it("updates on repeated calls (picks up additions/deletions changes)", async () => {
			useWorkspaceGitStore.setState({
				byWorkspaceId: { "ws-rw2": { ...baseInfo } },
				inFlight: new Set(),
			});
			vi.mocked(git.changedFiles)
				.mockImplementationOnce(noFiles)
				.mockImplementationOnce(twoFiles);
			await useWorkspaceGitStore.getState().refreshWorkspace("ws-rw2", "/repo");
			await useWorkspaceGitStore.getState().refreshWorkspace("ws-rw2", "/repo");
			const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-rw2"];
			expect(info?.changedFileCount).toBe(2);
			expect(git.changedFiles).toHaveBeenCalledTimes(2);
		});

		it("preserves currentBranch and isGitRepo", async () => {
			useWorkspaceGitStore.setState({
				byWorkspaceId: {
					"ws-rw3": { ...baseInfo, currentBranch: "feature-x" },
				},
				inFlight: new Set(),
			});
			vi.mocked(git.changedFiles).mockImplementation(noFiles);
			await useWorkspaceGitStore.getState().refreshWorkspace("ws-rw3", "/repo");
			const info = useWorkspaceGitStore.getState().byWorkspaceId["ws-rw3"];
			expect(info?.currentBranch).toBe("feature-x");
			expect(info?.isGitRepo).toBe(true);
		});

		it("skips update when entry does not exist", async () => {
			useWorkspaceGitStore.setState({ byWorkspaceId: {}, inFlight: new Set() });
			vi.mocked(git.changedFiles).mockImplementation(twoFiles);
			await useWorkspaceGitStore
				.getState()
				.refreshWorkspace("ws-rw4-missing", "/repo");
			expect(
				useWorkspaceGitStore.getState().byWorkspaceId["ws-rw4-missing"],
			).toBeUndefined();
		});

		it("swallows errors silently", async () => {
			vi.mocked(git.changedFiles).mockRejectedValue(new Error("git gone"));
			await expect(
				useWorkspaceGitStore.getState().refreshWorkspace("ws-rw5", "/repo"),
			).resolves.toBeUndefined();
		});
	});

	it("remove leaves other entries intact", () => {
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				"ws-keep": {
					isGitRepo: true,
					currentBranch: "main",
					changedFileCount: 0,
					conflictedPaths: [],
					additions: 0,
					deletions: 0,
				},
				"ws-del": {
					isGitRepo: false,
					currentBranch: null,
					changedFileCount: 0,
					conflictedPaths: [],
					additions: 0,
					deletions: 0,
				},
			},
			inFlight: new Set(),
		});
		useWorkspaceGitStore.getState().remove("ws-del");
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-keep"],
		).toBeDefined();
		expect(
			useWorkspaceGitStore.getState().byWorkspaceId["ws-del"],
		).toBeUndefined();
	});
});

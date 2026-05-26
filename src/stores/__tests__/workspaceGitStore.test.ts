import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceGitStore } from "../workspaceGitStore";

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
// biome-ignore lint/suspicious/noExplicitAny: mock data
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
	] as any[]);

function resetStore() {
	useWorkspaceGitStore.setState({ byWorkspaceId: {}, inFlight: new Set() });
}

const baseInfo = {
	isGitRepo: true as const,
	currentBranch: "main",
	changedFileCount: 0,
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
			},
			{
				workspaceId: "ws-b",
				isGitRepo: true,
				currentBranch: "dev",
				changedFileCount: 2,
				additions: 10,
				deletions: 3,
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

	it("setInfo updates entry directly", () => {
		useWorkspaceGitStore.getState().setInfo("ws-x", {
			isGitRepo: true,
			currentBranch: "feature/test",
			changedFileCount: 3,
			additions: 20,
			deletions: 5,
		});
		expect(useWorkspaceGitStore.getState().byWorkspaceId["ws-x"]).toEqual({
			isGitRepo: true,
			currentBranch: "feature/test",
			changedFileCount: 3,
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
					additions: 0,
					deletions: 0,
				},
				"ws-del": {
					isGitRepo: false,
					currentBranch: null,
					changedFileCount: 0,
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

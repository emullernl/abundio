import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	BranchCommit,
	BranchCommits,
	WorkspaceWithTabs,
} from "../../../lib/types";
import { useExplorerStore } from "../../../stores/explorerStore";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { CommitsSection } from "../CommitsSection";

const { commitFiles, commitFileDiff, openUrl } = vi.hoisted(() => ({
	commitFiles: vi.fn(),
	commitFileDiff: vi.fn(),
	openUrl: vi.fn(),
}));

vi.mock("../../../lib/ipc", () => ({
	git: { commitFiles, commitFileDiff },
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: openUrl }));
vi.mock("../../../lib/clipboard", () => ({
	writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));

function workspace(id: string, rootFolder: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder,
		agentPresetsJson: "",
		fileTabsJson: "",
		baseBranch: "main",
		lastBranch: null,
		position: 0,
		profileId: "p",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [],
	};
}

const commit = (
	oid: string,
	over: Partial<BranchCommit> = {},
): BranchCommit => ({
	oid,
	subject: `subject ${oid}`,
	message: `subject ${oid}`,
	authorName: "Emil Müller",
	authorEmail: "e@example.com",
	time: Math.floor(Date.now() / 1000) - 7200,
	isMerge: false,
	onRemote: false,
	...over,
});

const list = (...cs: BranchCommit[]): BranchCommits => ({
	base: "main",
	total: cs.length,
	commits: cs,
	githubSlug: "o/r",
});

describe("CommitsSection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function render(
		state: Partial<ReturnType<typeof useGitChangesStore.getState>>,
	) {
		useGitChangesStore.setState({
			branchCommits: null,
			baseBranch: "main",
			currentBranch: "feature",
			error: null,
			...state,
		});
		act(() => root.render(<CommitsSection />));
	}

	beforeEach(() => {
		commitFiles.mockReset();
		commitFileDiff.mockReset();
		openUrl.mockReset().mockResolvedValue(undefined);
		useWindowUiStore.setState({ commitsSectionCollapsed: false });
		useWorkspaceGitStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			byWorkspaceId: { a: { isGitRepo: true } } as any,
			repoSlugsById: { a: ["o/r"] },
		});
		useWorkspaceStore.setState({
			activeWorkspaceId: "a",
			workspaces: [workspace("a", "/repos/a")],
			activeTabByWorkspace: {},
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const text = () => container.textContent ?? "";

	it("lists the branch's commits with initials, age and the count", () => {
		render({ branchCommits: list(commit("a1"), commit("b2")) });
		expect(text()).toContain("Branch Commits");
		expect(text()).toContain("(2)");
		expect(text()).toContain("vs main");
		expect(text()).toContain("subject a1");
		expect(text()).toContain("EM");
		expect(text()).toContain("2h");
	});

	it("says so when nothing is ahead of the base", () => {
		render({ branchCommits: list() });
		expect(text()).toContain("No commits ahead of main");
	});

	it("says so for a non-git workspace", () => {
		useWorkspaceGitStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			byWorkspaceId: { a: { isGitRepo: false } } as any,
		});
		render({});
		expect(text()).toContain("Not a git repository");
	});

	it("reports an unresolvable base once a bundle has arrived", () => {
		render({ branchCommits: null, currentBranch: "feature" });
		expect(text()).toContain("Base branch not found");
	});

	it("shows a failed refresh's own error, not a missing base", () => {
		render({
			branchCommits: null,
			currentBranch: "feature",
			error: "index is locked",
		});
		expect(text()).toContain("index is locked");
		expect(text()).not.toContain("Base branch not found");
	});

	it("shows how many were left out past the cap", () => {
		render({ branchCommits: { ...list(commit("a1")), total: 1285 } });
		expect(text()).toContain("(1,285)");
		expect(text()).toContain("1,284 more not shown");
	});

	it("hides the body but keeps the header when collapsed", () => {
		useWindowUiStore.setState({ commitsSectionCollapsed: true });
		render({ branchCommits: list(commit("a1")) });
		expect(text()).toContain("Branch Commits");
		expect(text()).not.toContain("subject a1");
	});

	it("expands a commit to its files and opens a commit diff pane", async () => {
		const oid = "9f3e1a7c0ffee00000000000000000000000beef";
		commitFiles.mockResolvedValue([
			{
				path: "src/x.ts",
				status: "M",
				additions: 3,
				deletions: 1,
				isBinary: false,
			},
		]);
		commitFileDiff.mockResolvedValue({ original: "o", modified: "m" });
		const openCommitDiff = vi.fn();
		useExplorerStore.setState({ openCommitDiff });
		render({ branchCommits: list(commit(oid)) });

		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		expect(commitFiles).toHaveBeenCalledWith("/repos/a", oid);
		expect(row.getAttribute("aria-expanded")).toBe("true");
		expect(text()).toContain("x.ts");

		const fileRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("x.ts"),
		) as HTMLElement;
		await act(async () => fileRow.click());
		expect(commitFileDiff).toHaveBeenCalledWith("/repos/a", oid, "src/x.ts");
		expect(openCommitDiff).toHaveBeenCalledWith(
			"a",
			oid,
			"src/x.ts",
			"o",
			"m",
			false,
		);
	});

	function menuButton(label: string) {
		return [...document.querySelectorAll("body button")].find(
			(b) => b.textContent === label,
		) as HTMLButtonElement | undefined;
	}

	it("disables Open on GitHub without a GitHub remote", () => {
		render({
			branchCommits: {
				...list(commit("a1", { onRemote: true })),
				githubSlug: null,
			},
		});
		const row = container.querySelector("[aria-haspopup]") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(menuButton("Open on GitHub")?.disabled).toBe(true);
	});

	it("says a failed file read failed, and retries on re-expand", async () => {
		commitFiles.mockRejectedValueOnce(new Error("locked"));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		render({ branchCommits: list(commit("a1")) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		expect(text()).toContain("Could not read this commit's files");
		expect(text()).not.toContain("No file changes");

		commitFiles.mockResolvedValueOnce([
			{
				path: "y.ts",
				status: "A",
				additions: 1,
				deletions: 0,
				isBinary: false,
			},
		]);
		await act(async () => row.click()); // collapse
		await act(async () => row.click()); // expand again
		expect(commitFiles).toHaveBeenCalledTimes(2);
		expect(text()).toContain("y.ts");
		err.mockRestore();
	});

	it("does not lose a toggle when two land in the same batch", async () => {
		commitFiles.mockResolvedValue([]);
		render({ branchCommits: list(commit("a1")) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => {
			row.click();
			row.click();
		});
		expect(row.getAttribute("aria-expanded")).toBe("false");
	});

	it("shows a binary file but does not open it", async () => {
		commitFiles.mockResolvedValue([
			{
				path: "logo.png",
				status: "M",
				additions: 0,
				deletions: 0,
				isBinary: true,
			},
		]);
		render({ branchCommits: list(commit("bin1")) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		const fileRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("logo.png"),
		) as HTMLButtonElement;
		expect(fileRow.disabled).toBe(true);
		expect(fileRow.textContent).toContain("binary");
		await act(async () => fileRow.click());
		expect(commitFileDiff).not.toHaveBeenCalled();
	});

	it("disables Open on GitHub for an unpushed commit", () => {
		render({ branchCommits: list(commit("a1", { onRemote: false })) });
		const row = container.querySelector("[aria-haspopup]") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(menuButton("Copy Hash")?.disabled).toBe(false);
		expect(menuButton("Open on GitHub")?.disabled).toBe(true);
	});

	it("opens a pushed commit on GitHub", () => {
		render({ branchCommits: list(commit("a1", { onRemote: true })) });
		const row = container.querySelector("[aria-haspopup]") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		act(() => menuButton("Open on GitHub")?.click());
		expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/commit/a1");
	});
});

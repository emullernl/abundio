import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMIT_HISTORY_CAP } from "../../../lib/commitHistory";
import type {
	CommitHistory,
	HistoryCommit,
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

const { revealInFolder } = vi.hoisted(() => ({
	revealInFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/ipc", () => ({
	git: { commitFiles, commitFileDiff },
	fs: { revealInFolder },
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
	over: Partial<HistoryCommit> = {},
): HistoryCommit => ({
	oid,
	subject: `subject ${oid}`,
	message: `subject ${oid}`,
	authorName: "Emil Müller",
	authorEmail: "e@example.com",
	time: Math.floor(Date.now() / 1000) - 7200,
	isMerge: false,
	shared: false,
	onRemote: false,
	...over,
});

/** Ahead rows as given; `ahead` counts the ones not marked shared. */
const list = (...cs: HistoryCommit[]): CommitHistory => ({
	base: "main",
	ahead: cs.filter((c) => !c.shared).length,
	commits: cs,
	githubSlug: "o/r",
});
const shared = (oid: string, over: Partial<HistoryCommit> = {}) =>
	commit(oid, { shared: true, ...over });

describe("CommitsSection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function render(
		state: Partial<ReturnType<typeof useGitChangesStore.getState>>,
	) {
		useGitChangesStore.setState({
			commitHistory: null,
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

	it("lists ahead commits, the base divider, then shared history", () => {
		render({
			commitHistory: list(commit("a1"), commit("b2"), shared("c3")),
		});
		expect(text()).toContain("Commits");
		expect(text()).toContain("2 ahead of main");
		expect(text()).toContain("subject a1");
		expect(text()).toContain("subject c3");
		expect(text()).toContain("EM");
		expect(text()).toContain("2h");
		// The divider sits between b2 and c3 and names the base.
		const t = text();
		const divider = t.indexOf("main", t.indexOf("subject b2"));
		expect(divider).toBeGreaterThan(t.indexOf("subject b2"));
		expect(divider).toBeLessThan(t.indexOf("subject c3"));
	});

	it("on the base branch: latest commits, no divider, no count", () => {
		render({ commitHistory: list(shared("c1"), shared("c2")) });
		expect(text()).toContain("subject c1");
		expect(text()).not.toContain("ahead of");
		expect(container.querySelector("[title^='Below: history']")).toBeNull();
	});

	it("with an unknown base: plain history, no divider, says so", () => {
		render({
			commitHistory: { ...list(commit("a1"), commit("b2")), base: null },
		});
		expect(text()).toContain("base unknown");
		expect(text()).toContain("subject b2");
		expect(container.querySelector("[title^='Below: history']")).toBeNull();
		expect(text()).not.toContain("Base branch not found");
	});

	it("says so for a repository with no commits yet", () => {
		render({ commitHistory: list() });
		expect(text()).toContain("No commits yet");
	});

	it("says so for a non-git workspace", () => {
		useWorkspaceGitStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			byWorkspaceId: { a: { isGitRepo: false } } as any,
		});
		render({});
		expect(text()).toContain("Not a git repository");
	});

	it("shows a failed refresh's own error", () => {
		render({
			commitHistory: null,
			currentBranch: "feature",
			error: "index is locked",
		});
		expect(text()).toContain("index is locked");
	});

	it("says when the list was cut at the cap, and keeps the true ahead count", () => {
		const rows = Array.from({ length: COMMIT_HISTORY_CAP }, (_, i) =>
			commit(`c${i}`),
		);
		render({ commitHistory: { ...list(...rows), ahead: 1285 } });
		expect(text()).toContain("1,285 ahead of main");
		expect(text()).toContain(
			`Showing the latest ${COMMIT_HISTORY_CAP} commits`,
		);
		// 200 rows in jsdom take ~1s alone and far longer under a loaded full run.
	}, 30_000);

	it("hides the body but keeps the header when collapsed", () => {
		useWindowUiStore.setState({ commitsSectionCollapsed: true });
		render({ commitHistory: list(commit("a1")) });
		expect(text()).toContain("Commits");
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
		render({ commitHistory: list(commit(oid)) });

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
			commitHistory: {
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
		render({ commitHistory: list(commit("a1")) });
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
		render({ commitHistory: list(commit("a1")) });
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
		render({ commitHistory: list(commit("bin1")) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		const fileRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("logo.png"),
		) as HTMLButtonElement;
		expect(fileRow.getAttribute("aria-disabled")).toBe("true");
		expect(fileRow.textContent).toContain("binary");
		await act(async () => fileRow.click());
		expect(commitFileDiff).not.toHaveBeenCalled();
		// Still right-clickable: the path actions apply to a binary file.
		act(() => {
			fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(menuButton("Open Diff")?.disabled).toBe(true);
		expect(menuButton("Copy Relative Path")?.disabled).toBe(false);
	});

	// Each test uses its own oid: commit file lists are cached per oid at
	// module level, for the life of the window — and of this test file.
	it("shows a submodule bump but does not open it", async () => {
		commitFiles.mockResolvedValue([
			{
				path: "vendor/lib",
				status: "M",
				additions: 0,
				deletions: 0,
				isBinary: false,
				isSubmodule: true,
			},
		]);
		render({ commitHistory: list(commit("sub1")) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		const fileRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("lib"),
		) as HTMLButtonElement;
		expect(fileRow.getAttribute("aria-disabled")).toBe("true");
		expect(fileRow.textContent).toContain("submodule");
		await act(async () => fileRow.click());
		expect(commitFileDiff).not.toHaveBeenCalled();
		act(() => {
			fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(menuButton("Open Diff")?.disabled).toBe(true);
		expect(menuButton("Open File")?.disabled).toBe(true);
		expect(menuButton("Copy Relative Path")?.disabled).toBe(false);
	});

	async function openFileMenu(
		oid: string,
		file: Partial<import("../../../lib/types").CommitFile> = {},
	) {
		commitFiles.mockResolvedValue([
			{
				path: "src/x.ts",
				status: "M",
				additions: 1,
				deletions: 0,
				isBinary: false,
				...file,
			},
		]);
		render({ commitHistory: list(commit(oid)) });
		const row = container.querySelector("[aria-expanded]") as HTMLElement;
		await act(async () => row.click());
		const fileRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("x.ts"),
		) as HTMLElement;
		act(() => {
			fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		return fileRow;
	}

	it("gives a commit's file row the Git changes Row menu", async () => {
		await openFileMenu("f1");
		const labels = [...document.querySelectorAll("body button")].map(
			(b) => b.textContent,
		);
		for (const l of [
			"Open Diff",
			"Open File",
			"Copy Relative Path",
			"Copy Path",
		])
			expect(labels).toContain(l);
		// Not the commit menu.
		expect(menuButton("Copy Hash")).toBeUndefined();
	});

	it("Open Diff opens that commit's diff of the file", async () => {
		commitFileDiff.mockResolvedValue({ original: "o", modified: "m" });
		const openCommitDiff = vi.fn();
		useExplorerStore.setState({ openCommitDiff });
		await openFileMenu("f2");
		await act(async () => menuButton("Open Diff")?.click());
		expect(openCommitDiff).toHaveBeenCalledWith(
			"a",
			"f2",
			"src/x.ts",
			"o",
			"m",
			false,
		);
	});

	it("copies the path as it is on disk now, and reveals it", async () => {
		const { writeClipboardText } = await import("../../../lib/clipboard");
		const fileRow = await openFileMenu("f3");
		act(() => menuButton("Copy Relative Path")?.click());
		expect(writeClipboardText).toHaveBeenCalledWith("src/x.ts");
		act(() => {
			fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		const reveal = [...document.querySelectorAll("body button")].find((b) =>
			/Reveal|Show|Open Containing/.test(b.textContent ?? ""),
		) as HTMLButtonElement;
		act(() => reveal.click());
		expect(revealInFolder).toHaveBeenCalledWith("/repos/a/src/x.ts");
	});

	it("disables Open File and Reveal for a path the commit deleted", async () => {
		await openFileMenu("f4", { status: "D" });
		expect(menuButton("Open File")?.disabled).toBe(true);
		expect(menuButton("Open Diff")?.disabled).toBe(false);
	});

	it("disables Open on GitHub for an unpushed commit", () => {
		render({ commitHistory: list(commit("a1", { onRemote: false })) });
		const row = container.querySelector("[aria-haspopup]") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(menuButton("Copy Hash")?.disabled).toBe(false);
		expect(menuButton("Open on GitHub")?.disabled).toBe(true);
	});

	it("opens a pushed commit on GitHub", () => {
		render({ commitHistory: list(commit("a1", { onRemote: true })) });
		const row = container.querySelector("[aria-haspopup]") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		act(() => menuButton("Open on GitHub")?.click());
		expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/commit/a1");
	});
});

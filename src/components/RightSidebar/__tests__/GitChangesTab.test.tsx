import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fs as fsApi } from "../../../lib/ipc";
import type { GitChangedFile, WorkspaceWithTabs } from "../../../lib/types";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { GitChangesTab } from "../GitChangesTab";

vi.mock("../../../lib/ipc", () => ({
	git: { fileDiff: vi.fn().mockResolvedValue({ original: "", modified: "" }) },
	fs: {
		revealInFolder: vi.fn().mockResolvedValue(undefined),
		fileExists: vi.fn().mockResolvedValue(true),
	},
}));

vi.mock("../../../lib/clipboard", () => ({
	writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));

const openFileWindow = vi.fn().mockResolvedValue(undefined);
const openFileWindowForPath = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../lib/openFileWindow", () => ({
	openFileWindow: (...a: unknown[]) => openFileWindow(...a),
	openFileWindowForPath: (...a: unknown[]) => openFileWindowForPath(...a),
}));

const FILE: GitChangedFile = {
	path: "src/lib/ipc.ts",
	section: "unstaged",
	status: "M",
	additions: 1,
	deletions: 0,
};

/**
 * A faithful `WorkspaceWithTabs`, `tabs` included.
 *
 * `terminalManager` registers a workspace-store subscriber from inside a
 * `setTimeout` (terminalManager.ts:760) and that subscriber maps
 * `workspace.tabs`. Whether the timer fires during this test is a race, so a
 * `tabs`-less fixture passes or throws depending on machine speed — it lost
 * that race locally and won it on CI. The fixture is valid either way now.
 */
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

describe("GitChangesTab — Row menu lifetime", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		useGitChangesStore.setState({
			changedFiles: [FILE],
			baseBranch: "main",
			currentBranch: "feature",
			loading: false,
			error: null,
			collapsedSections: {},
			operationInProgress: null,
		});
		// These suites are about the file **Row menu**; List view keeps the file
		// row the first thing that carries a menu.
		useSettingsStore.setState({ gitChangesTreeView: false });
		useWorkspaceGitStore.setState({
			byWorkspaceId: {
				a: { isGitRepo: true },
				b: { isGitRepo: true },
				// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			} as any,
		});
		useWorkspaceStore.setState({
			activeWorkspaceId: "a",
			workspaces: [workspace("a", "/repos/a"), workspace("b", "/repos/b")],
			activeTabByWorkspace: {},
		});

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root.render(<GitChangesTab />));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function openMenu() {
		const row = container.querySelector(
			'[aria-haspopup="menu"]',
		) as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
	}

	const menuLabels = () =>
		[...document.querySelectorAll("body button")]
			.map((b) => b.textContent ?? "")
			.filter((t) => t === "Copy Relative Path");

	it("opens a menu on the row", () => {
		openMenu();
		expect(menuLabels()).toHaveLength(1);
	});

	it("closes when the active workspace changes", () => {
		// The tab is not keyed by workspace, and the command palette switches from
		// the keyboard alone — nothing else would close the menu, leaving repo A's
		// row resolving against repo B's root.
		openMenu();
		expect(menuLabels()).toHaveLength(1);

		act(() => {
			useWorkspaceStore.setState({ activeWorkspaceId: "b" });
		});

		expect(menuLabels()).toHaveLength(0);
	});
});

describe("GitChangesTab — Open in Separate Window", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function render(file: GitChangedFile) {
		useGitChangesStore.setState({
			changedFiles: [file],
			baseBranch: "main",
			currentBranch: "feature",
			loading: false,
			error: null,
			collapsedSections: {},
			operationInProgress: null,
		});
		// These suites are about the file **Row menu**; List view keeps the file
		// row the first thing that carries a menu.
		useSettingsStore.setState({ gitChangesTreeView: false });
		useWorkspaceGitStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			byWorkspaceId: { a: { isGitRepo: true } } as any,
		});
		useWorkspaceStore.setState({
			activeWorkspaceId: "a",
			workspaces: [workspace("a", "/repos/a")],
			activeTabByWorkspace: {},
		});
		act(() => root.render(<GitChangesTab />));
		const row = container.querySelector(
			'[aria-haspopup="menu"]',
		) as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
	}

	const item = (label = "Open File in Separate Window") =>
		[...document.querySelectorAll<HTMLButtonElement>("body button")].find(
			(b) => b.textContent === label,
		);

	beforeEach(() => {
		openFileWindow.mockClear();
		openFileWindowForPath.mockClear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("opens a row's file, resolved against the Workspace root", () => {
		render({ ...FILE, path: "docs/notes.md" });
		act(() => {
			item()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(openFileWindowForPath).toHaveBeenCalledWith(
			"a",
			"/repos/a/docs/notes.md",
		);
	});

	it("opens a row's live diff, from its section", () => {
		render({ ...FILE, section: "staged" });
		act(() => {
			item("Open Diff in Separate Window")?.dispatchEvent(
				new MouseEvent("click", { bubbles: true }),
			);
		});
		expect(openFileWindow).toHaveBeenCalledWith("a", {
			kind: "diff",
			filePath: "src/lib/ipc.ts",
			diffSection: "staged",
		});
	});

	it("is not offered on a file a pane cannot show", () => {
		render({ ...FILE, path: "dist/app.zip" });
		expect(item()).toBeUndefined();
		expect(item("Open Diff in Separate Window")).toBeUndefined();
	});
});

describe("GitChangesTab — Folder menu", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		useGitChangesStore.setState({
			changedFiles: [FILE],
			baseBranch: "main",
			currentBranch: "feature",
			loading: false,
			error: null,
			collapsedSections: {},
			collapsedFolders: {},
			operationInProgress: null,
		});
		useSettingsStore.setState({ gitChangesTreeView: true });
		useWorkspaceGitStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: partial store fixture
			byWorkspaceId: { a: { isGitRepo: true } } as any,
		});
		useWorkspaceStore.setState({
			activeWorkspaceId: "a",
			workspaces: [workspace("a", "/repos/a")],
			activeTabByWorkspace: {},
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root.render(<GitChangesTab />));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function openFolderMenu(exists: boolean) {
		vi.mocked(fsApi.fileExists).mockResolvedValueOnce(exists);
		const row = [
			...container.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]'),
		].find((el) => el.textContent === "src/lib") as HTMLElement;
		await act(async () => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
	}

	const menuButton = (label: string) =>
		[...document.querySelectorAll<HTMLButtonElement>("body button")].find(
			(b) => b.textContent === label,
		);

	it("checks the deepest folder of the merged row on disk", async () => {
		await openFolderMenu(true);
		expect(fsApi.fileExists).toHaveBeenLastCalledWith("/repos/a/src/lib");
		expect(menuButton("Copy Relative Path")).toBeDefined();
		expect(menuButton("Open Diff")).toBeUndefined();
	});

	it("drops a Folder menu whose lookup finishes after a Row menu opened", async () => {
		let resolveLookup: (exists: boolean) => void = () => {};
		vi.mocked(fsApi.fileExists).mockReturnValueOnce(
			new Promise((r) => {
				resolveLookup = r;
			}),
		);
		const folderRow = [
			...container.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]'),
		].find((el) => el.textContent === "src/lib") as HTMLElement;
		act(() => {
			folderRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		const fileRow = [
			...container.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]'),
		].find((el) => el.textContent?.includes("ipc.ts")) as HTMLElement;
		act(() => {
			fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		await act(async () => resolveLookup(true));
		// Only the Row menu: one Copy Relative Path, and its Open Diff.
		const copies = [...document.querySelectorAll("body button")].filter(
			(b) => b.textContent === "Copy Relative Path",
		);
		expect(copies).toHaveLength(1);
		expect(menuButton("Open Diff")).toBeDefined();
	});

	it("disables Reveal on a folder that is gone from disk", async () => {
		await openFolderMenu(false);
		const reveal = [
			...document.querySelectorAll<HTMLButtonElement>("body button"),
		].find((b) => (b.textContent ?? "").startsWith("Reveal"));
		expect(reveal?.disabled).toBe(true);
		expect(menuButton("Copy Path")?.disabled).toBe(false);
	});
});

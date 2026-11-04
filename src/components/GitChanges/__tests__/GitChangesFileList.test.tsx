import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitChangedFile } from "../../../lib/types";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { GitChangesFileList } from "../GitChangesFileList";

function file(
	path: string,
	section: GitChangedFile["section"],
	status = "M",
): GitChangedFile {
	return { path, section, status, additions: 0, deletions: 0 };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onFolderContextMenu = vi.fn();

function renderList(files: GitChangedFile[]) {
	act(() => {
		root.render(
			<GitChangesFileList
				files={files}
				baseBranch="main"
				onSelectFile={vi.fn()}
				onOpenFile={vi.fn()}
				onContextMenu={vi.fn()}
				selectedFile={null}
				menuTargetFile={null}
				onFolderContextMenu={onFolderContextMenu}
				menuTargetFolder={null}
			/>,
		);
	});
}

describe("GitChangesFileList — conflicted section", () => {
	beforeEach(() => {
		useGitChangesStore.setState({
			collapsedSections: {},
			collapsedFolders: {},
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const headings = () =>
		[...container.querySelectorAll("*")]
			.map((el) => el.textContent ?? "")
			.filter((t) =>
				[
					"Conflicted",
					"Against main",
					"Staged",
					"Unstaged",
					"Untracked",
				].includes(t),
			);

	it("renders Conflicted before every other section", () => {
		renderList([
			file("b.txt", "unstaged"),
			file("c.txt", "against_base"),
			file("a.txt", "conflicted", "U"),
		]);
		expect(headings()[0]).toBe("Conflicted");
		expect(headings()).toContain("Unstaged");
	});

	it("omits the Conflicted section when nothing is unmerged", () => {
		renderList([file("b.txt", "unstaged")]);
		expect(headings()).not.toContain("Conflicted");
	});

	it("gives a conflicted row no Open File button", () => {
		// The row's own click already opens the text pane (the conflicted section
		// is the one section that does), so the nested button would duplicate it.
		renderList([file("a.txt", "conflicted", "U")]);
		expect(container.querySelector('[title="Open File"]')).toBeNull();
	});

	it("keeps the Open File button on an ordinary row", () => {
		renderList([file("b.txt", "unstaged")]);
		expect(container.querySelector('[title="Open File"]')).not.toBeNull();
	});
});

describe("GitChangesFileList — Tree view", () => {
	beforeEach(() => {
		useGitChangesStore.setState({
			collapsedSections: {},
			collapsedFolders: {},
		});
		useSettingsStore.setState({ gitChangesTreeView: true });
		onFolderContextMenu.mockClear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const rowTexts = () =>
		[...container.querySelectorAll('[role="button"]')].map((el) =>
			(el.textContent ?? "").replace(/^M/, ""),
		);

	const folderRow = (name: string) =>
		[...container.querySelectorAll('[role="button"][aria-expanded]')].find(
			(el) => el.textContent === name && !el.hasAttribute("aria-label"),
		) as HTMLElement;

	it("nests files under merged folder rows, folders first", () => {
		renderList([
			file("README.md", "unstaged"),
			file("src/components/GitChanges/List.tsx", "unstaged"),
			file("src/App.tsx", "unstaged"),
		]);
		expect(rowTexts()).toEqual([
			"src",
			"components/GitChanges",
			"List.tsx",
			"App.tsx",
			"README.md",
		]);
	});

	it("folds a folder in one Section only", () => {
		renderList([file("src/a.ts", "staged"), file("src/b.ts", "unstaged")]);
		const [stagedSrc] = [
			...container.querySelectorAll('[role="button"][aria-expanded]'),
		].filter((el) => el.textContent === "src") as HTMLElement[];
		act(() => stagedSrc.click());
		expect(rowTexts()).toEqual(["src", "src", "b.ts"]);
	});

	it("folds from the keyboard", () => {
		renderList([file("src/a.ts", "unstaged")]);
		act(() => {
			folderRow("src").dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(rowTexts()).toEqual(["src"]);
	});

	it("opens the Folder menu with the deepest folder of a merged row", () => {
		renderList([file("src/lib/a.ts", "unstaged")]);
		act(() => {
			folderRow("src/lib").dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					clientX: 5,
					clientY: 6,
				}),
			);
		});
		expect(onFolderContextMenu).toHaveBeenCalledWith(
			5,
			6,
			{ section: "unstaged", path: "src/lib" },
			false,
		);
	});

	it("names an untracked folder row with its trailing slash", () => {
		renderList([file("src/newdir/", "untracked", "?")]);
		expect(rowTexts()).toEqual(["src", "Unewdir/"]);
	});

	it("does not carry a fold into another Workspace", () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "a" });
		renderList([file("src/a.ts", "unstaged")]);
		act(() => folderRow("src").click());
		expect(rowTexts()).toEqual(["src"]);
		act(() => useWorkspaceStore.setState({ activeWorkspaceId: "b" }));
		expect(rowTexts()).toEqual(["src", "a.ts"]);
	});

	it("keeps a merged row's fold on its deepest folder when the row splits", () => {
		renderList([file("a/b/x.ts", "unstaged")]);
		act(() => folderRow("a/b").click());
		renderList([file("a/b/x.ts", "unstaged"), file("a/y.ts", "unstaged")]);
		expect(rowTexts()).toEqual(["a", "b", "y.ts"]);
		expect(folderRow("b").getAttribute("aria-expanded")).toBe("false");
	});

	it("drops the grey folder path from file rows", () => {
		renderList([file("src/a.ts", "unstaged")]);
		expect(container.textContent).not.toContain("a.tssrc");
	});

	it("List view keeps the flat rows with their folder path", () => {
		useSettingsStore.setState({ gitChangesTreeView: false });
		renderList([file("src/a.ts", "unstaged"), file("b.ts", "unstaged")]);
		expect(rowTexts()).toEqual(["b.ts", "a.tssrc"]);
	});
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitChangedFile } from "../../../lib/types";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { GitChangesFileList } from "../GitChangesFileList";

function file(
	path: string,
	section: GitChangedFile["section"],
	status = "M",
): GitChangedFile {
	return { path, section, status, additions: 0, deletions: 0 };
}

describe("GitChangesFileList — conflicted section", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		useGitChangesStore.setState({ collapsedSections: {} });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderList(files: GitChangedFile[]) {
		act(() => {
			root.render(
				<GitChangesFileList
					files={files}
					baseBranch="main"
					onSelectFile={vi.fn()}
					onOpenFile={vi.fn()}
					selectedFile={null}
				/>,
			);
		});
	}

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

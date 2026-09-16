import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitChangedFile, WorkspaceWithTabs } from "../../../lib/types";
import { useGitChangesStore } from "../../../stores/gitChangesStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { GitChangesTab } from "../GitChangesTab";

vi.mock("../../../lib/ipc", () => ({
	git: { fileDiff: vi.fn().mockResolvedValue({ original: "", modified: "" }) },
	fs: { revealInFolder: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../lib/clipboard", () => ({
	writeClipboardText: vi.fn().mockResolvedValue(undefined),
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

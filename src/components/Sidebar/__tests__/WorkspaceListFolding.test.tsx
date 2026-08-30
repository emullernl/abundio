import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../../lib/ipc", () => ({
	worktrees: {
		dirty: vi.fn().mockResolvedValue(false),
		add: vi.fn(),
		remove: vi.fn(),
	},
	git: { workspacesSummary: vi.fn().mockResolvedValue([]) },
	workspaces: { update: vi.fn().mockResolvedValue(undefined) },
}));

import type { WorkspaceWithTabs } from "../../../lib/types";
import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { WorkspaceList } from "../WorkspaceList";

// WorkspaceItem measures its own height through a ResizeObserver (it publishes
// `--workspace-item-height` for the narrow sidebar's strips); jsdom has none.
class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver ??=
	NoopResizeObserver as unknown as typeof ResizeObserver;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GROUP_KEY = "/repos/abundio/.git";

function workspace(
	id: string,
	name: string,
	position: number,
	ptyId?: string,
): WorkspaceWithTabs {
	return {
		id,
		name,
		rootFolder: `/repos/${name}`,
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: ptyId
			? [
					{
						id: `tab-${id}`,
						workspaceId: id,
						name: "Terminal",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: `pane-${id}`,
							ptyId,
						}),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				]
			: [],
	};
}

const PRIMARY = workspace("ws-primary", "abundio", 0);
const LINKED_A = workspace("ws-a", "feat-a", 1, "pty-a");
const LINKED_B = workspace("ws-b", "feat-b", 2);
const STANDALONE = workspace("ws-solo", "other-repo", 3);

function agentEntry(state: PtyActivityEntry["state"]): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode: "agent",
		hookDriven: false,
	};
}

describe("WorkspaceList — folded Worktree sets", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [PRIMARY, LINKED_A, LINKED_B, STANDALONE],
			activeWorkspaceId: PRIMARY.id,
			switchingWorkspaceId: null,
		});
		useWorkspaceGitStore.setState({
			worktreeFacts: {
				[PRIMARY.id]: { worktreeGroupKey: GROUP_KEY, isMainWorktree: true },
				[LINKED_A.id]: { worktreeGroupKey: GROUP_KEY, isMainWorktree: false },
				[LINKED_B.id]: { worktreeGroupKey: GROUP_KEY, isMainWorktree: false },
			},
			byWorkspaceId: {},
		});
		usePtyActivityStore.setState({
			activities: {},
			panePtyMap: {},
			openedWorkspaceIds: new Set<string>(),
		});
		useWindowUiStore.setState({ foldedSetKeys: [] });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(variant: "expanded" | "collapsed" = "expanded") {
		act(() => {
			root.render(<WorkspaceList variant={variant} />);
		});
	}

	const names = () =>
		[...container.querySelectorAll("span")]
			.map((el) => el.textContent ?? "")
			.filter((t) => ["abundio", "feat-a", "feat-b", "other-repo"].includes(t));

	const foldButton = () =>
		container.querySelector<HTMLButtonElement>(
			'button[aria-label="Fold worktrees"], button[aria-label="Unfold worktrees"]',
		);

	it("renders every set member when unfolded", () => {
		render();
		expect(names()).toEqual(["abundio", "feat-a", "feat-b", "other-repo"]);
	});

	it("hides the Linked worktree rows when folded", () => {
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		expect(names()).toEqual(["abundio", "other-repo"]);
	});

	it("offers the chevron only on a set's Primary row", () => {
		render();
		const buttons = container.querySelectorAll(
			'button[aria-label="Fold worktrees"], button[aria-label="Unfold worktrees"]',
		);
		expect(buttons.length).toBe(1);
	});

	it("chevron toggles the fold without activating the workspace", () => {
		render();
		const beginWorkspaceSwitch = vi.fn();
		useWorkspaceStore.setState({ beginWorkspaceSwitch });
		render();
		act(() => {
			foldButton()?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([GROUP_KEY]);
		expect(beginWorkspaceSwitch).not.toHaveBeenCalled();
		expect(names()).toEqual(["abundio", "other-repo"]);
	});

	it("shows the hidden count and rolled-up status while folded", () => {
		usePtyActivityStore.setState({
			activities: { "pty-a": agentEntry("waiting") },
			openedWorkspaceIds: new Set([LINKED_A.id]),
		});
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		const chip = container.querySelector<HTMLElement>("[title*='feat-a']");
		expect(chip).toBeTruthy();
		expect(chip?.textContent).toContain("2");
		// Tooltip names every hidden worktree and its state.
		expect(chip?.getAttribute("title")).toBe(
			"feat-a — Waiting\nfeat-b — Not opened",
		);
	});

	it("keeps the rollup live while the hidden rows are unmounted", () => {
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		const title = () =>
			container
				.querySelector<HTMLElement>("[title*='feat-a']")
				?.getAttribute("title");
		expect(title()).toContain("feat-a — Not opened");
		act(() => {
			usePtyActivityStore.setState({
				activities: { "pty-a": agentEntry("error") },
				openedWorkspaceIds: new Set([LINKED_A.id]),
			});
		});
		expect(title()).toContain("feat-a — Error");
	});

	it("unfolds when a hidden Linked worktree becomes the Active workspace", () => {
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		expect(names()).toEqual(["abundio", "other-repo"]);
		act(() => {
			useWorkspaceStore.setState({ activeWorkspaceId: LINKED_A.id });
		});
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
		expect(names()).toEqual(["abundio", "feat-a", "feat-b", "other-repo"]);
	});

	it("ignores a stale key whose group is no longer a set", () => {
		// Git facts gone (e.g. still loading at launch): the members render as
		// ordinary standalone rows and the key simply has no effect.
		useWorkspaceGitStore.setState({ worktreeFacts: {} });
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		expect(names()).toEqual(["abundio", "feat-a", "feat-b", "other-repo"]);
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([GROUP_KEY]);
	});

	it("honours the fold in the narrow sidebar too", () => {
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render("collapsed");
		expect(names()).toEqual(["abundio", "other-repo"]);
	});
});

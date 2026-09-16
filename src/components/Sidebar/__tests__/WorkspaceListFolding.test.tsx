import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../../lib/ipc", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
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

const PRIMARY = workspace("ws-primary", "abundio", 0, "pty-primary");
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
		shellCommandRunning: false,
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
			uncommittedById: {},
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
		const chip = container.querySelector<HTMLElement>("[data-hidden-rollup]");
		expect(chip).toBeTruthy();
		expect(chip?.textContent).toContain("2");
		// The whole chip's tooltip names every hidden worktree and its state.
		expect(chip?.getAttribute("title")).toBe(
			"feat-a — Waiting\nfeat-b — Not opened",
		);
		// Each rollup icon hovers to its own breakdown, summed over hidden members.
		expect(
			chip?.querySelector("[data-rollup='agent']")?.getAttribute("title"),
		).toBe("Agents: 1 Waiting");
		expect(chip?.querySelector("[data-rollup='terminal']")).toBeNull();
	});

	it("gives a row its own Agent and Terminal rollups, each with a breakdown", () => {
		usePtyActivityStore.setState({
			activities: {
				"pty-primary": { ...agentEntry("active"), detectionMode: "shell" },
			},
			openedWorkspaceIds: new Set([PRIMARY.id]),
		});
		render();
		const rows = container.querySelectorAll("[data-rollup]");
		// Only the Primary has a PTY, and it is a shell: one Terminal rollup,
		// no Agent rollup (absent, not Idle).
		expect(rows).toHaveLength(1);
		expect(rows[0].getAttribute("data-rollup")).toBe("terminal");
		expect(rows[0].getAttribute("title")).toBe("Terminals: 1 Working");
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

	it("rolls up the hidden members only, never the Primary", () => {
		// The single most reversible-by-accident property: someone "fixes" the
		// rollup to include the primary and every other test still passes.
		usePtyActivityStore.setState({
			activities: { "pty-primary": agentEntry("error") },
			openedWorkspaceIds: new Set([PRIMARY.id, LINKED_A.id]),
		});
		useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
		render();
		const chip = container.querySelector<HTMLElement>("[data-hidden-rollup]");
		// Idle + never-opened hidden members — the primary's Error stays out of it.
		expect(chip?.getAttribute("title")).toBe(
			"feat-a — Idle\nfeat-b — Not opened",
		);
	});

	it("withholds the fold control while the set holds the Active workspace", () => {
		// Folding here would be undone by the auto-unfold invariant on the very
		// next render, so the affordance is absent rather than dead.
		useWorkspaceStore.setState({ activeWorkspaceId: LINKED_A.id });
		render();
		expect(foldButton()?.disabled).toBe(true);
		act(() => {
			foldButton()?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});
		expect(useWindowUiStore.getState().foldedSetKeys).toEqual([]);
		expect(names()).toEqual(["abundio", "feat-a", "feat-b", "other-repo"]);
	});

	it("offers the fold control again once the Active workspace leaves the set", () => {
		useWorkspaceStore.setState({ activeWorkspaceId: LINKED_A.id });
		render();
		act(() => {
			useWorkspaceStore.setState({ activeWorkspaceId: STANDALONE.id });
		});
		expect(foldButton()?.disabled).toBe(false);
		act(() => {
			foldButton()?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});
		expect(names()).toEqual(["abundio", "other-repo"]);
	});

	describe("Dirty marker", () => {
		const markers = () => [
			...container.querySelectorAll<HTMLElement>("[data-dirty-marker]"),
		];
		const chipOf = (branch: string) =>
			container.querySelector<HTMLElement>(`[title='${branch}']`);
		const gitInfo = (branch: string) => ({
			isGitRepo: true,
			currentBranch: branch,
			changedFileCount: 0,
			additions: 0,
			deletions: 0,
			conflictedPaths: [],
		});

		it("bars the right edge of a dirty workspace's row, even when unopened", () => {
			useWorkspaceGitStore.setState({
				byWorkspaceId: {
					[STANDALONE.id]: gitInfo("main"),
					[PRIMARY.id]: gitInfo("trunk"),
				},
				uncommittedById: {
					[STANDALONE.id]: { dirty: true, breakdown: null },
					[PRIMARY.id]: { dirty: false, breakdown: null },
				},
			});
			render();
			expect(markers()).toHaveLength(1);
			expect(markers()[0].getAttribute("title")).toBe("Uncommitted changes");
			// On the dirty workspace's own row — the one its branch chip is in.
			const row = markers()[0].parentElement;
			expect(row?.contains(chipOf("main") as Node)).toBe(true);
			expect(row?.contains(chipOf("trunk") as Node)).toBe(false);
			// The row background is untouched: it still carries active and hover.
			expect(row?.style.backgroundColor).toBe("transparent");
		});

		it("does not count committed history: a Branch stat alone draws no marker", () => {
			usePtyActivityStore.setState({
				openedWorkspaceIds: new Set([STANDALONE.id]),
			});
			useWorkspaceGitStore.setState({
				byWorkspaceId: {
					[STANDALONE.id]: {
						...gitInfo("feature"),
						changedFileCount: 5,
						additions: 200,
						deletions: 30,
					},
				},
				uncommittedById: {
					[STANDALONE.id]: {
						dirty: false,
						breakdown: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
					},
				},
			});
			render();
			expect(markers()).toHaveLength(0);
			const stat = container.querySelector<HTMLElement>(
				"[title^='vs the default branch']",
			);
			expect(stat?.getAttribute("title")).toBe(
				"vs the default branch: 5 files, +200 −30, including uncommitted",
			);
		});

		it("carries a hidden member's dirtiness into the Hidden rollup and its tooltip", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { [LINKED_B.id]: { dirty: true, breakdown: null } },
			});
			useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
			render();
			const chip = container.querySelector<HTMLElement>("[data-hidden-rollup]");
			expect(chip?.querySelector("[data-dirty-marker]")).toBeTruthy();
			expect(chip?.getAttribute("title")).toBe(
				"feat-a — Not opened\nfeat-b — Not opened · uncommitted",
			);
		});

		it("leaves the Hidden rollup ringless when only the Primary is dirty (its own bar says that)", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { [PRIMARY.id]: { dirty: true, breakdown: null } },
			});
			useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
			render();
			const chip = container.querySelector<HTMLElement>("[data-hidden-rollup]");
			expect(chip?.querySelector("[data-dirty-marker]")).toBeNull();
			expect(markers()).toHaveLength(1);
		});

		it("shows a hidden member's dirtiness on the folded Primary's narrow strip", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { [LINKED_A.id]: { dirty: true, breakdown: null } },
			});
			useWindowUiStore.setState({ foldedSetKeys: [GROUP_KEY] });
			render("collapsed");
			expect(markers()).toHaveLength(1);
			expect(markers()[0].getAttribute("title")).toBe(
				"Uncommitted changes in a hidden worktree",
			);
		});
	});
});

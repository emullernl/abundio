import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { HiddenRollup } from "../../../hooks/useWorkspaceRollups";
import type { WorkspaceWithTabs } from "../../../lib/types";
import {
	type PtyActivityEntry,
	usePtyActivityStore,
} from "../../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../../stores/workspaceGitStore";
import { DOT_STATUS_COLOR } from "../../AgentStatusIcon";
import { CollapsedStrip } from "../CollapsedStrip";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function workspace(ptyIds: string[]): WorkspaceWithTabs {
	return {
		id: "ws-1",
		name: "acme-web",
		rootFolder: "/Users/demo/code/acme-web",
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: ptyIds.map((ptyId, i) => ({
			id: `tab-${i}`,
			workspaceId: "ws-1",
			name: `Tab ${i}`,
			layoutJson: JSON.stringify({ type: "terminal", id: `p-${i}`, ptyId }),
			position: i,
			createdAt: 0,
			updatedAt: 0,
		})),
	};
}

function entry(
	state: PtyActivityEntry["state"],
	detectionMode: "agent" | "shell",
): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
		shellCommandRunning: false,
	};
}

describe("CollapsedStrip", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		usePtyActivityStore.setState({
			activities: {},
			panePtyMap: {},
			openedWorkspaceIds: new Set<string>(),
		});
		useWorkspaceGitStore.setState({ uncommittedById: {} });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(ws: WorkspaceWithTabs, hidden?: HiddenRollup) {
		act(() => {
			root.render(
				<CollapsedStrip
					workspace={ws}
					isActive={false}
					isRenaming={false}
					onClick={() => {}}
					onDelete={() => {}}
					onContextMenu={() => {}}
					onRename={() => {}}
					onRenameCancel={() => {}}
					hidden={hidden}
				/>,
			);
		});
	}

	const composite = () =>
		container.querySelector<HTMLElement>("[data-status-composite]");
	const badge = () =>
		container.querySelector<HTMLElement>("[data-status-badge]");

	it("shows the single grey icon for a never-opened workspace", () => {
		render(workspace([]));
		expect(composite()?.getAttribute("data-status-composite")).toBe("grey");
		expect(container.querySelector(".text-zinc-500")).not.toBeNull();
	});

	it("leads with the Agent rollup and badges the Terminal rollup", () => {
		usePtyActivityStore.setState({
			activities: {
				a: entry("waiting", "agent"),
				b: entry("active", "shell"),
			},
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		render(workspace(["a", "b"]));
		expect(composite()?.getAttribute("data-status-composite")).toBe("skyblue");
		expect(badge()?.getAttribute("data-status-badge")).toBe("cyan");
		// One tooltip carries both, since an 8px badge is a poor hover target.
		expect(composite()?.getAttribute("title")).toBe(
			"Agents: 1 Waiting\nTerminals: 1 Working",
		);
	});

	it("promotes the Terminal rollup to primary when there are no Agents", () => {
		usePtyActivityStore.setState({
			activities: { b: entry("idle", "shell") },
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		render(workspace(["b"]));
		// Idle shows here — the suppression belongs to the badge, not the rollup.
		expect(composite()?.getAttribute("data-status-composite")).toBe("green");
		expect(badge()).toBeNull();
		expect(container.querySelector(".text-zinc-500")).toBeNull();
	});

	it("draws nothing at all when the workspace has no PTYs of either kind", () => {
		usePtyActivityStore.setState({
			activities: {},
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		render(workspace([]));
		expect(composite()).toBeNull();
	});

	it("shows the folder under the name, with the home directory as ~", () => {
		render(workspace([]));
		const texts = [...container.querySelectorAll("span")].map(
			(el) => el.textContent,
		);
		const name = texts.indexOf("acme-web");
		expect(name).toBeGreaterThanOrEqual(0);
		expect(texts[name + 1]).toBe("~/code/acme-web");
	});

	const hiddenCount = () =>
		container.querySelector<HTMLElement>("[data-hidden-count]");

	it("tints the Hidden-rollup count when a hidden member wants attention", () => {
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["ws-1"]) });
		render(workspace([]), {
			agent: { status: "amber", counts: counts({ working: 1 }) },
			terminal: { status: "red", counts: counts({ error: 1 }) },
			count: 2,
			notOpened: false,
			badge: "red",
			dirty: false,
			membersTooltip: "feat-a — Error\nfeat-b — Working",
		});
		expect(hiddenCount()?.textContent).toBe("+2");
		expect(hiddenCount()?.style.color).toBe(DOT_STATUS_COLOR.red);
	});

	it("leaves the Hidden-rollup count neutral for a merely-working member", () => {
		// Amber Working is mundane: a colour here would read as "N things are
		// running" rather than "something wants you" (ADR-0033).
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["ws-1"]) });
		render(workspace([]), {
			agent: { status: "amber", counts: counts({ working: 1 }) },
			terminal: null,
			count: 3,
			notOpened: false,
			badge: "amber",
			dirty: false,
			membersTooltip: "feat-a — Working",
		});
		expect(hiddenCount()?.textContent).toBe("+3");
		expect(hiddenCount()?.style.color).toBe("var(--fg-secondary)");
	});

	it("has no hidden count when nothing is hidden", () => {
		render(workspace([]));
		expect(hiddenCount()).toBeNull();
	});

	describe("Dirty marker", () => {
		const marker = () =>
			container.querySelector<HTMLElement>("[data-dirty-marker]");
		const hiddenRollup = (dirty: boolean): HiddenRollup => ({
			agent: null,
			terminal: null,
			count: 1,
			notOpened: true,
			badge: "grey",
			dirty,
			membersTooltip: "feat-a — Not opened",
		});

		it("draws no ring for a clean workspace", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { "ws-1": { dirty: false, breakdown: null } },
			});
			render(workspace([]), hiddenRollup(false));
			expect(marker()).toBeNull();
		});

		it("draws an edge bar for the workspace's own uncommitted work", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: {
					"ws-1": {
						dirty: true,
						breakdown: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
					},
				},
			});
			render(workspace([]));
			expect(marker()?.getAttribute("title")).toBe("Uncommitted: 2 unstaged");
			expect(marker()?.style.width).toBe("3px");
		});

		it("draws a ring on the rollup when only a hidden member is dirty", () => {
			render(workspace([]), hiddenRollup(true));
			expect(marker()?.getAttribute("title")).toBe(
				"Uncommitted changes in a hidden worktree",
			);
		});

		it("keeps the two apart: an edge bar for itself, a ring for the hidden member", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { "ws-1": { dirty: true, breakdown: null } },
			});
			render(workspace([]), hiddenRollup(true));
			const titles = [
				...container.querySelectorAll<HTMLElement>("[data-dirty-marker]"),
			].map((el) => el.getAttribute("title"));
			expect(titles).toEqual([
				"Uncommitted changes in a hidden worktree",
				"Uncommitted changes",
			]);
		});

		it("draws the hidden member's marker hollow, so it never reads as a status badge", () => {
			render(workspace([]), hiddenRollup(true));
			expect(marker()?.style.border).toContain("var(--warning)");
			expect(marker()?.style.backgroundColor).not.toContain("--warning");
		});
	});
});

function counts(partial: Partial<Record<string, number>>) {
	return { error: 0, waiting: 0, ready: 0, working: 0, idle: 0, ...partial };
}

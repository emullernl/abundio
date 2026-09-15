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

	const rollup = (kind: "agent" | "terminal") =>
		container.querySelector<HTMLElement>(`[data-rollup='${kind}']`);

	it("shows the single grey icon for a never-opened workspace", () => {
		render(workspace([]));
		expect(rollup("agent")).toBeNull();
		expect(rollup("terminal")).toBeNull();
		expect(container.querySelector(".text-zinc-500")).not.toBeNull();
	});

	it("stacks the Agent rollup over the Terminal rollup, each with its breakdown", () => {
		usePtyActivityStore.setState({
			activities: {
				a: entry("waiting", "agent"),
				b: entry("active", "shell"),
			},
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		render(workspace(["a", "b"]));
		const agent = rollup("agent");
		const terminal = rollup("terminal");
		expect(agent?.getAttribute("title")).toBe("Agents: 1 Waiting");
		expect(terminal?.getAttribute("title")).toBe("Terminals: 1 Working");
		// Agent above Terminal in document order.
		if (!agent || !terminal) throw new Error("both rollups should render");
		expect(
			agent.compareDocumentPosition(terminal) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("draws nothing for an absent rollup — not Idle, not grey", () => {
		usePtyActivityStore.setState({
			activities: { b: entry("idle", "shell") },
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		render(workspace(["b"]));
		expect(rollup("agent")).toBeNull();
		expect(rollup("terminal")).not.toBeNull();
		expect(container.querySelector(".text-zinc-500")).toBeNull();
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

	it("colours the Hidden-rollup badge from the more urgent hidden status", () => {
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
		const badge = container.querySelector<HTMLElement>("[data-hidden-badge]");
		expect(badge?.getAttribute("data-hidden-badge")).toBe("red");
		expect(badge?.style.backgroundColor).toBe(DOT_STATUS_COLOR.red);
	});

	it("has no badge when nothing is hidden", () => {
		render(workspace([]));
		expect(container.querySelector("[data-hidden-badge]")).toBeNull();
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

		it("draws a ring for the workspace's own uncommitted work", () => {
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
		});

		it("draws the same ring when only a hidden member is dirty", () => {
			render(workspace([]), hiddenRollup(true));
			expect(marker()?.getAttribute("title")).toBe(
				"Uncommitted changes in a hidden worktree",
			);
		});

		it("says both when the workspace and a hidden member are dirty", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { "ws-1": { dirty: true, breakdown: null } },
			});
			render(workspace([]), hiddenRollup(true));
			expect(container.querySelectorAll("[data-dirty-marker]")).toHaveLength(1);
			expect(marker()?.getAttribute("title")).toBe(
				"Uncommitted changes · also in a hidden worktree",
			);
		});

		it("is hollow, so it never reads as a filled status badge", () => {
			useWorkspaceGitStore.setState({
				uncommittedById: { "ws-1": { dirty: true, breakdown: null } },
			});
			render(workspace([]));
			expect(marker()?.style.border).toContain("var(--warning)");
			expect(marker()?.style.backgroundColor).not.toContain("--warning");
		});
	});
});

function counts(partial: Partial<Record<string, number>>) {
	return { error: 0, waiting: 0, ready: 0, working: 0, idle: 0, ...partial };
}

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../lib/terminalManager", () => ({
	getTerminal: () => undefined,
}));
const switchToPane = vi.fn();
vi.mock("../../../lib/paneLocation", () => ({
	switchToPane: (id: string) => switchToPane(id),
}));

import type { PaneNode, WorkspaceWithTabs } from "../../../lib/types";
import {
	type PtyActivityEntry,
	usePtyActivityStore,
} from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { AgentsList } from "../AgentsList";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function term(id: string, ptyId: string): PaneNode {
	return { type: "terminal", id, ptyId } as PaneNode;
}

function ws(
	id: string,
	name: string,
	tabs: [string, string, PaneNode][],
	position: number,
): WorkspaceWithTabs {
	return {
		id,
		name,
		rootFolder: `/code/${id}`,
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: tabs.map(([tabId, tabName, layout], i) => ({
			id: tabId,
			workspaceId: id,
			name: tabName,
			layoutJson: JSON.stringify(layout),
			position: i,
			createdAt: 0,
			updatedAt: 0,
		})),
	};
}

function entry(detectionMode: "agent" | "shell"): PtyActivityEntry {
	return {
		state: "idle",
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
		shellCommandRunning: false,
	} as PtyActivityEntry;
}

let container: HTMLDivElement;
let root: Root;

function render() {
	act(() => {
		root.render(<AgentsList />);
	});
}

function rows(): HTMLElement[] {
	return Array.from(container.querySelectorAll('[data-testid="agent-row"]'));
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	switchToPane.mockClear();

	useWorkspaceStore.setState({
		workspaces: [
			ws("a", "alpha", [["a1", "Main", term("pa1", "x1")]], 0),
			ws(
				"b",
				"beta",
				[
					["b1", "Build", term("pb1", "y1")],
					["b2", "Shell", term("pb2", "y2")],
				],
				1,
			),
			ws("c", "gamma", [["c1", "Main", term("pc1", "z1")]], 2),
		],
		activeWorkspaceId: "b",
		focusedPaneId: "pb1",
	});
	usePtyActivityStore.setState({
		openedWorkspaceIds: new Set(["a", "b"]),
		panePtyMap: {},
		activities: {
			x1: entry("agent"),
			y1: entry("agent"),
			y2: entry("shell"),
			z1: entry("agent"), // in a Workspace that is not Opened
		},
		titles: { pb1: "Fix the flaky test" },
		detectedAgentIds: { x1: "codex", y1: "claude" },
	});
	useWindowUiStore.setState({
		agentsListCollapsed: false,
		pendingTiles: {},
	});
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("AgentsList", () => {
	it("lists agent-mode panes of Opened workspaces, in sidebar order", () => {
		render();
		const r = rows();
		expect(r).toHaveLength(2);
		expect(r[0].textContent).toContain("alpha · Main");
		expect(r[1].textContent).toContain("beta · Build");
		expect(
			container.querySelector('[data-testid="agents-count"]')?.textContent,
		).toBe("· 2");
	});

	it("sorts rows in Handle order across Workspaces", () => {
		const named = (id: string, ptyId: string, agentHandle: string) =>
			({ type: "terminal", id, ptyId, agentHandle }) as PaneNode;
		useWorkspaceStore.setState({
			workspaces: [
				ws("a", "alpha", [["a1", "Main", named("pa1", "x1", "Agent Ten")]], 0),
				ws(
					"b",
					"beta",
					[
						["b1", "Build", named("pb1", "y1", "Agent Two")],
						["b2", "Shell", term("pb2", "y2")],
					],
					1,
				),
			],
		});
		render();
		const r = rows();
		expect(r[0].textContent).toContain("Agent Two");
		expect(r[1].textContent).toContain("Agent Ten");
	});

	it("shows the Agent's terminal title, else the Agent's name", () => {
		render();
		const [codex, claude] = rows();
		const codexName =
			useSettingsStore.getState().agents.find((a) => a.id === "codex")?.name ??
			"";
		expect(codexName).not.toBe("");
		expect(codex.textContent).toContain(codexName);
		expect(claude.textContent).toContain("Fix the flaky test");
	});

	it("does not list a pending Fleet tile", () => {
		useWindowUiStore.setState({
			pendingTiles: { pb2: Date.now() },
		});
		render();
		expect(rows()).toHaveLength(2);
	});

	it("selects the Focused pane of the Active workspace only", () => {
		render();
		const [a, b] = rows();
		expect(b.getAttribute("aria-current")).toBe("true");
		expect(a.getAttribute("aria-current")).toBeNull();

		// The focused pane id points at a Background workspace's pane: no row
		// is selected, because the Active workspace's own pane is not focused.
		act(() => {
			useWorkspaceStore.setState({ activeWorkspaceId: "a" });
		});
		expect(rows().some((r) => r.getAttribute("aria-current"))).toBe(false);
	});

	it("clicking a row switches to its pane", () => {
		render();
		act(() => rows()[0].click());
		expect(switchToPane).toHaveBeenCalledWith("pa1");
	});

	it("right-clicking a row opens the Agent menu", () => {
		render();
		act(() => {
			rows()[1].dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
		const labels = Array.from(document.body.querySelectorAll("button"))
			.map((b) => b.textContent)
			.filter(Boolean);
		expect(labels).toContain("Switch To");
		expect(labels).toContain("Restart Agent…");
		expect(labels).toContain("Close Pane");
		expect(labels).not.toContain("Clear Attention Flag");
	});

	it("Open in Fleet Console focuses that Agent's tile", () => {
		useWindowUiStore.setState({
			fleetConsoleOpen: false,
			focusedTileId: null,
			spotlightTileId: null,
		});
		render();
		act(() => {
			rows()[0].dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
		const item = Array.from(document.body.querySelectorAll("button")).find(
			(b) => b.textContent === "Open in Fleet Console",
		);
		act(() => item?.click());
		const ui = useWindowUiStore.getState();
		expect(ui.fleetConsoleOpen).toBe(true);
		expect(ui.focusedTileId).toBe("pa1");
	});

	it("keeps its header and says so when no Agent runs", () => {
		usePtyActivityStore.setState({ activities: {} });
		render();
		expect(rows()).toHaveLength(0);
		expect(container.textContent).toContain("No agents running");
		expect(container.textContent).toContain("Agents");
	});

	it("collapses to its header", () => {
		render();
		const header = container.querySelector("button[aria-expanded]");
		act(() => (header as HTMLButtonElement).click());
		expect(useWindowUiStore.getState().agentsListCollapsed).toBe(true);
		expect(rows()).toHaveLength(0);
		expect(
			container.querySelector('[data-testid="agents-count"]')?.textContent,
		).toBe("· 2");
	});
});

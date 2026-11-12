import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(
	async (cmd: string, _args?: unknown): Promise<unknown> =>
		cmd === "file_windows_list"
			? [
					{
						label: "md-1",
						workspaceId: "b",
						kind: "text",
						filePath: "/code/b/NOTES.md",
						commitOid: null,
					},
				]
			: undefined,
);
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock("../../../lib/terminalManager", () => ({
	getTerminal: () => undefined,
}));
const switchToPane = vi.fn();
const revealPane = vi.fn();
vi.mock("../../../lib/paneLocation", () => ({
	switchToPane: (id: string) => switchToPane(id),
	revealPane: (...a: unknown[]) => revealPane(...a),
}));

import type { PaneNode, WorkspaceWithTabs } from "../../../lib/types";
import {
	type PtyActivityEntry,
	usePtyActivityStore,
} from "../../../stores/ptyActivityStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { Navigator } from "../Navigator";

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

function entry(
	detectionMode: "agent" | "shell",
	state: PtyActivityEntry["state"] = "idle",
): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
		shellCommandRunning: false,
	} as PtyActivityEntry;
}

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render() {
	act(() => {
		root.render(<Navigator open onClose={onClose} />);
	});
}

function rowTexts(): string[] {
	return Array.from(
		container.querySelectorAll('[data-testid="navigator-row"]'),
	).map((r) => r.textContent ?? "");
}

function selectedText(): string {
	return (
		container.querySelector(
			'[data-testid="navigator-row"][aria-selected="true"]',
		)?.textContent ?? ""
	);
}

function input(): HTMLInputElement {
	return container.querySelector("input") as HTMLInputElement;
}

function key(k: string) {
	act(() => {
		input().dispatchEvent(
			new KeyboardEvent("keydown", { key: k, bubbles: true }),
		);
	});
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	switchToPane.mockClear();
	revealPane.mockClear();
	onClose.mockClear();

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
			x1: entry("agent", "waiting"),
			y1: entry("agent"),
			y2: entry("shell"),
		},
		titles: { pb1: "Fix the flaky test", pb2: "zsh" },
		cwds: {},
		detectedAgentIds: { x1: "codex", y1: "claude" },
	});
	useWindowUiStore.setState({ fleetConsoleOpen: false });
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("Navigator", () => {
	it("shows Opened workspaces as a tree, Focused pane preselected", () => {
		render();
		const texts = rowTexts();
		expect(texts).toHaveLength(8);
		expect(texts[0]).toContain("alpha");
		expect(texts.some((t) => t.includes("gamma"))).toBe(false);
		expect(selectedText()).toContain("Fix the flaky test");
	});

	it("Enter on a pane row is Switch to and closes", () => {
		render();
		key("Enter");
		expect(switchToPane).toHaveBeenCalledWith("pb1");
		expect(onClose).toHaveBeenCalled();
	});

	it("arrow keys move, Left goes to the parent, Enter on a Tab reveals it", () => {
		render();
		key("ArrowLeft");
		expect(selectedText()).toContain("Build");
		key("Enter");
		expect(revealPane).toHaveBeenCalledWith(null, "b", "b1");
	});

	it("Left on an expanded Workspace collapses it", () => {
		render();
		key("ArrowLeft"); // → Tab "Build"
		key("ArrowLeft"); // → Workspace beta
		key("ArrowLeft"); // collapse
		expect(rowTexts().some((t) => t.includes("Fix the flaky test"))).toBe(
			false,
		);
	});

	it("lists File windows under their Workspace; picking one focuses it", async () => {
		render();
		await act(async () => {});
		const texts = rowTexts();
		expect(texts).toHaveLength(9);
		expect(texts[8]).toContain("NOTES.md");
		const row = container.querySelectorAll<HTMLElement>(
			'[data-testid="navigator-row"]',
		)[8];
		await act(async () => row.click());
		await act(async () => {});
		expect(invoke).toHaveBeenCalledWith("file_window_focus", { label: "md-1" });
		expect(onClose).toHaveBeenCalled();
	});

	it("a status chip keeps only Agents in that state", () => {
		render();
		const waiting = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === "Waiting",
		) as HTMLButtonElement;
		act(() => waiting.click());
		const texts = rowTexts();
		expect(texts).toHaveLength(3);
		expect(texts[0]).toContain("alpha");
	});

	it("the scope toggle adds workspaces that are not Opened", () => {
		render();
		const all = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === "All workspaces",
		) as HTMLButtonElement;
		act(() => all.click());
		expect(rowTexts().some((t) => t.includes("gamma"))).toBe(true);
	});
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hidden = vi.hoisted(() => ({
	started: [] as string[],
	cancelled: [] as string[],
}));

vi.mock("../../../lib/terminalManager", () => ({
	shownGrid: () => null,
	startPtyUnlessShown: (paneId: string) => {
		hidden.started.push(paneId);
		return () => hidden.cancelled.push(paneId);
	},
}));

vi.mock("../TerminalInstance", () => ({
	TerminalInstance: ({ paneId }: { paneId: string }) => (
		<div data-terminal={paneId} />
	),
}));

import {
	setPendingAgent,
	takePendingAgent,
} from "../../../lib/pendingAgentRegistry";
import type { CodingAgent, WorkspaceWithTabs } from "../../../lib/types";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { TerminalPool } from "../TerminalPool";

function ws(id: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab",
				layoutJson: JSON.stringify({
					type: "terminal",
					id: `${id}-p`,
					ptyId: "",
				}),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

describe("TerminalPool", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const rendered = () =>
		[...container.querySelectorAll("[data-terminal]")].map((e) =>
			e.getAttribute("data-terminal"),
		);

	it("holds back background workspaces while the active one starts", () => {
		useWorkspaceStore.setState({
			workspaces: [ws("a"), ws("b")],
			activeWorkspaceId: "a",
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["a", "b"]) });
		act(() => root.render(<TerminalPool />));
		expect(rendered()).toEqual(["a-p"]);
	});

	// A Workspace opened from the Fleet Console before any was activated: with
	// nothing to put first, waiting for an active workspace would be forever.
	it("loads every opened workspace when none is active", () => {
		useWorkspaceStore.setState({
			workspaces: [ws("a"), ws("b")],
			activeWorkspaceId: null,
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["b"]) });
		act(() => root.render(<TerminalPool />));
		expect(rendered()).toEqual(["b-p"]);
	});

	// Opening a Workspace starts its remembered Agents in every Tab, not only
	// in Tabs that get shown, so each is in the Agents list at once.
	describe("remembered Agents in hidden Tabs", () => {
		const tab = (id: string, position: number, layout: object) => ({
			id,
			workspaceId: "w",
			name: id,
			layoutJson: JSON.stringify(layout),
			position,
			createdAt: 0,
			updatedAt: 0,
		});
		const workspace = {
			id: "w",
			name: "w",
			rootFolder: "/w",
			tabs: [
				tab("t1", 0, { type: "terminal", id: "shell", ptyId: "" }),
				tab("t2", 1, {
					type: "split",
					id: "s",
					direction: "vertical",
					ratio: 0.5,
					first: {
						type: "terminal",
						id: "agent",
						ptyId: "",
						agentId: "claude",
					},
					second: { type: "terminal", id: "off", ptyId: "", agentId: "codex" },
				}),
			],
		} as unknown as WorkspaceWithTabs;

		beforeEach(() => {
			hidden.started.length = 0;
			hidden.cancelled.length = 0;
			useSettingsStore.setState({
				agents: [
					{ id: "claude", enabled: true },
					{ id: "codex", enabled: false },
				] as CodingAgent[],
			});
			setPendingAgent("agent", { command: "claude" });
			setPendingAgent("off", { command: "codex" });
			useWorkspaceStore.setState({
				workspaces: [workspace],
				activeWorkspaceId: "w",
			});
		});

		afterEach(() => {
			takePendingAgent("agent");
			takePendingAgent("off");
		});

		it("starts a Watched Agent's pane, but not a plain shell or a switched-off Agent", () => {
			usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["w"]) });
			act(() => root.render(<TerminalPool />));
			expect(hidden.started).toEqual(["agent"]);
		});

		it("does nothing for a Workspace that is not Opened", () => {
			usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
			act(() => root.render(<TerminalPool />));
			expect(hidden.started).toEqual([]);
		});

		it("cancels a waiting start when its Workspace closes", () => {
			usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["w"]) });
			act(() => root.render(<TerminalPool />));
			act(() =>
				usePtyActivityStore.setState({ openedWorkspaceIds: new Set() }),
			);
			expect(hidden.cancelled).toEqual(["agent"]);
		});
	});
});

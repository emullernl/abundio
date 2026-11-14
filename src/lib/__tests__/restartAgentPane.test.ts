import { beforeEach, describe, expect, it, vi } from "vitest";

const restartPanePty = vi.fn(async () => {});
vi.mock("../terminalManager", () => ({
	restartPanePty: (...a: unknown[]) =>
		(restartPanePty as (...a: unknown[]) => Promise<void>)(...a),
	livePtyIdByPane: () => ({ pa: "x1" }),
	killUnmountedPanePty: vi.fn(),
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { restartAgentPane } from "../paneRestart";
import type { PaneNode, WorkspaceWithTabs } from "../types";

function workspace(layout: PaneNode): WorkspaceWithTabs {
	return {
		id: "w",
		name: "w",
		rootFolder: "/code/w",
		agentPresetsJson: "{}",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [
			{
				id: "t",
				workspaceId: "w",
				name: "Main",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	};
}

beforeEach(() => {
	restartPanePty.mockClear();
	usePtyActivityStore.setState({
		panePtyMap: { pa: "x1" },
		activities: {},
		titles: {},
	});
});

describe("restartAgentPane", () => {
	it("restarts only that pane, relaunching its Agent", async () => {
		useWorkspaceStore.setState({
			workspaces: [
				workspace({
					type: "split",
					id: "s",
					direction: "horizontal",
					ratio: 0.5,
					first: {
						type: "terminal",
						id: "pa",
						ptyId: "x1",
						agentId: "claude",
					},
					second: { type: "terminal", id: "pb", ptyId: "x2" },
				} as PaneNode),
			],
		});
		await restartAgentPane("pa");
		expect(restartPanePty).toHaveBeenCalledTimes(1);
		expect(restartPanePty).toHaveBeenCalledWith(
			"pa",
			expect.objectContaining({
				cwd: "/code/w",
				preserveScrollback: true,
				agentCommand: expect.stringContaining("claude"),
			}),
		);
	});

	it("does nothing for a pane with no live PTY", async () => {
		useWorkspaceStore.setState({
			workspaces: [
				workspace({ type: "terminal", id: "pz", ptyId: "" } as PaneNode),
			],
		});
		await restartAgentPane("pz");
		expect(restartPanePty).not.toHaveBeenCalled();
	});
});

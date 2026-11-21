import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminalManager", () => ({
	killUnmountedPanePty: vi.fn(),
	livePtyIdByPane: vi.fn(() => ({
		"p-live": "live-pty",
		"p-dead": "dead-pty",
	})),
	restartPanePty: vi.fn(() => Promise.resolve()),
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { recoverJoinedWorkspace } from "../paneRestart";
import { restartPanePty } from "../terminalManager";

describe("recoverJoinedWorkspace (phase 10: a joined Host came back)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const layout = {
			type: "split",
			id: "s",
			direction: "horizontal",
			ratio: 0.5,
			first: { type: "terminal", id: "p-live", ptyId: "live-pty" },
			second: {
				type: "terminal",
				id: "p-dead",
				ptyId: "dead-pty",
				agentId: "claude",
				agentSessionId: "sid-1",
			},
		};
		useWorkspaceStore.setState({
			workspaces: [
				{
					id: "ws",
					name: "app",
					rootFolder: "/home/dev/app",
					agentPresetsJson: "{}",
					fileTabsJson: "{}",
					baseBranch: null,
					lastBranch: null,
					position: 0,
					profileId: "remote",
					createdAt: 0,
					updatedAt: 0,
					worktreeSetupCommands: "",
					joined: { hostId: "box" },
					tabs: [
						{
							id: "t",
							workspaceId: "ws",
							name: "Tab",
							layoutJson: JSON.stringify(layout),
							position: 0,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				},
			],
		});
	});

	it("restarts the panes that died with the Host and resyncs the ones that ran on", async () => {
		const resync = vi.fn(() => Promise.resolve());
		const initPty = vi.spyOn(usePtyActivityStore.getState(), "initPty");
		const out = await recoverJoinedWorkspace("ws", "box", {
			alive: () => Promise.resolve(["live-pty"]),
			resync,
		});
		expect(out).toEqual({ restarted: 1, resynced: 1 });
		expect(restartPanePty).toHaveBeenCalledWith("p-dead", {
			cwd: "/home/dev/app",
			agentCommand: "claude --resume sid-1",
			preserveScrollback: true,
		});
		expect(restartPanePty).not.toHaveBeenCalledWith(
			"p-live",
			expect.anything(),
		);
		expect(resync).toHaveBeenCalledWith(["live-pty"]);
		expect(initPty).toHaveBeenCalledWith("live-pty");
	});

	it("leaves alone a pane started since the Host went away", async () => {
		const resync = vi.fn(() => Promise.resolve());
		const out = await recoverJoinedWorkspace("ws", "box", {
			alive: () => Promise.resolve(["live-pty", "dead-pty"]),
			resync,
			only: new Set(["dead-pty"]),
		});
		// "live-pty" is not one it had: never resynced (that would wipe the
		// scrollback its restart restored).
		expect(out).toEqual({ restarted: 0, resynced: 1 });
		expect(resync).toHaveBeenCalledWith(["dead-pty"]);
	});
});

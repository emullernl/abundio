import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode, WorkspaceWithTabs } from "../types";

const ensure = vi.fn();
const agent = vi.fn();
const setAgent = vi.fn();
vi.mock("../ipc", async (orig) => ({
	...(await orig<typeof import("../ipc")>()),
	orchestrator: {
		ensure: (...a: unknown[]) => ensure(...a),
		agent: (...a: unknown[]) => agent(...a),
		setAgent: (...a: unknown[]) => setAgent(...a),
	},
	tabs: { update: vi.fn(() => Promise.resolve()) },
	shells: { default: () => Promise.resolve("/bin/zsh") },
	workspaces: {
		setRestoreActive: vi.fn(() => Promise.resolve()),
		setRestoreOpened: vi.fn(() => Promise.resolve()),
	},
}));
const restartPanePty = vi.fn();
vi.mock("../terminalManager", () => ({
	getTerminal: () => undefined,
	restartPanePty: (...a: unknown[]) => restartPanePty(...a),
}));
const setPendingAgent = vi.fn();
const setPendingTask = vi.fn();
vi.mock("../pendingAgentRegistry", async (orig) => ({
	...(await orig<typeof import("../pendingAgentRegistry")>()),
	setPendingAgent: (...a: unknown[]) => setPendingAgent(...a),
	setPendingTask: (...a: unknown[]) => setPendingTask(...a),
}));

const {
	EXIT_PICKER_DELAY_MS,
	enterOrchestratorView,
	installOrchestratorSession,
	leaveOrchestratorView,
	pickOrchestratorAgent,
} = await import("../orchestratorSession");
const { useOrchestratorStore } = await import("../../stores/orchestratorStore");
const { useWorkspaceStore } = await import("../../stores/workspaceStore");
const { useWindowUiStore } = await import("../../stores/windowUiStore");
const { usePtyActivityStore } = await import("../../stores/ptyActivityStore");
const { useSettingsStore } = await import("../../stores/settingsStore");

function ws(id: string, kind: "work" | "orchestrator", layout: PaneNode) {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "00000000-0000-0000-0000-000000000001",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		kind,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab 1",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} satisfies WorkspaceWithTabs;
}

const work = ws("app", "work", { type: "terminal", id: "w1", ptyId: "" });
const orch = ws("orch", "orchestrator", {
	type: "terminal",
	id: "o1",
	ptyId: "",
});

describe("orchestratorSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		ensure.mockResolvedValue(orch);
		setAgent.mockResolvedValue(undefined);
		useWorkspaceStore.setState({
			workspaces: [work],
			activeWorkspaceId: "app",
			activeTabByWorkspace: { app: "app-t" },
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["app"]) });
		useOrchestratorStore.setState({
			phase: "idle",
			workspaceId: null,
			agentId: null,
			returnWorkspaceId: null,
			changingAgent: false,
		});
		useWindowUiStore.setState({ orchestratorViewOpen: true });
		useSettingsStore.setState({
			agents: [
				{
					id: "claude",
					name: "Claude Code",
					command: "claude",
					enabled: true,
					continueArgs: ["--continue"],
				},
			],
		} as never);
	});

	it("asks for an Agent first, without taking the Active slot", async () => {
		agent.mockResolvedValue(null);
		await enterOrchestratorView();
		expect(useOrchestratorStore.getState().phase).toBe("pick");
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("app");
		expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toContain(
			"orch",
		);
	});

	it("starts the picked Agent as the Orchestrator, then hands back on leave", async () => {
		agent.mockResolvedValue(null);
		await enterOrchestratorView();
		await pickOrchestratorAgent("claude");
		expect(setAgent).toHaveBeenCalledWith(expect.any(String), "claude");
		// A new pick starts plainly, through the spawn: nothing to resume.
		expect(setPendingTask).toHaveBeenCalledWith("o1", {
			argv: ["claude"],
			agentId: "claude",
		});
		expect(setPendingAgent).not.toHaveBeenCalled();
		const stored = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === "orch");
		expect(JSON.parse(stored?.tabs[0].layoutJson ?? "{}")).toMatchObject({
			agentId: "claude",
			agentHandle: "Orchestrator",
		});
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("orch");
		expect(useOrchestratorStore.getState().phase).toBe("ready");

		leaveOrchestratorView();
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("app");
		expect(useOrchestratorStore.getState().phase).toBe("idle");
	});

	it("resumes a remembered Orchestrator that is not running yet", async () => {
		const running = ws("orch", "orchestrator", {
			type: "terminal",
			id: "o1",
			ptyId: "",
			agentId: "claude",
			agentHandle: "Orchestrator",
		});
		ensure.mockResolvedValue(running);
		agent.mockResolvedValue("claude");
		await enterOrchestratorView();
		// Not live yet (app start): resumed through the spawn, with a plain
		// start to fall back on.
		expect(setPendingTask).toHaveBeenCalledWith(
			"o1",
			expect.objectContaining({
				argv: ["claude", "--continue"],
				fallback: "claude",
			}),
		);
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("orch");
	});

	it("asks for an Agent again when its Agent exits, not when its pane closes", async () => {
		agent.mockResolvedValue(null);
		useWindowUiStore.setState({ orchestratorViewOpen: false });
		const stop = installOrchestratorSession();
		useWindowUiStore.setState({ orchestratorViewOpen: true });
		await enterOrchestratorView();
		await pickOrchestratorAgent("claude");
		setPendingTask.mockClear();
		const setLayout = (layout: PaneNode) =>
			useWorkspaceStore.setState((s) => ({
				workspaces: s.workspaces.map((w) =>
					w.id === "orch"
						? {
								...w,
								tabs: [{ ...w.tabs[0], layoutJson: JSON.stringify(layout) }],
							}
						: w,
				),
			}));
		vi.useFakeTimers();
		try {
			// The Agent exits: the pane stays, its Agent and handle go. The
			// picker waits, so the Agent's last output can be read.
			setLayout({ type: "terminal", id: "o1", ptyId: "" });
			expect(useOrchestratorStore.getState().exited).toBe(false);
			await vi.advanceTimersByTimeAsync(EXIT_PICKER_DELAY_MS + 10);
			expect(useOrchestratorStore.getState().exited).toBe(true);
			expect(setPendingTask).not.toHaveBeenCalled();
			// The same Agent again resumes the conversation it left.
			await pickOrchestratorAgent("claude");
			expect(useOrchestratorStore.getState().exited).toBe(false);
			expect(setPendingTask).toHaveBeenCalledWith(
				"o1",
				expect.objectContaining({ argv: ["claude", "--continue"] }),
			);
			// Closing the pane is not an exit.
			setLayout({ type: "terminal", id: "other", ptyId: "" });
			await vi.advanceTimersByTimeAsync(EXIT_PICKER_DELAY_MS + 10);
			expect(useOrchestratorStore.getState().exited).toBe(false);
		} finally {
			vi.useRealTimers();
			stop();
		}
	});
});

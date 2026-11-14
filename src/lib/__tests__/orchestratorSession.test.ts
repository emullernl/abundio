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
vi.mock("../pendingAgentRegistry", async (orig) => ({
	...(await orig<typeof import("../pendingAgentRegistry")>()),
	setPendingAgent: (...a: unknown[]) => setPendingAgent(...a),
}));

const { enterOrchestratorView, leaveOrchestratorView, pickOrchestratorAgent } =
	await import("../orchestratorSession");
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
				{ id: "claude", name: "Claude Code", command: "claude", enabled: true },
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
		expect(setPendingAgent).toHaveBeenCalledWith("o1", { command: "claude" });
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

	it("does not reseed an Orchestrator that already runs its Agent", async () => {
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
		expect(setPendingAgent).not.toHaveBeenCalled();
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("orch");
	});
});

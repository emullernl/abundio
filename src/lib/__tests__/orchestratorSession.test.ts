import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode, WorkspaceWithTabs } from "../types";

const ensure = vi.fn();
const agent = vi.fn();
const setAgent = vi.fn();
const setFolder = vi.fn();
vi.mock("../ipc", async (orig) => ({
	...(await orig<typeof import("../ipc")>()),
	orchestrator: {
		ensure: (...a: unknown[]) => ensure(...a),
		agent: (...a: unknown[]) => agent(...a),
		setAgent: (...a: unknown[]) => setAgent(...a),
		setFolder: (...a: unknown[]) => setFolder(...a),
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
	chooseOrchestratorFolder,
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
			lastSession: null,
		});
		useWindowUiStore.setState({ orchestratorViewOpen: true });
		useSettingsStore.setState({
			agents: [
				{
					id: "claude",
					name: "Claude Code",
					command: "claude",
					enabled: true,
					resumeArgs: ["--resume", "{session}"],
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
			agentSessionId: "sid-1",
		});
		ensure.mockResolvedValue(running);
		agent.mockResolvedValue("claude");
		await enterOrchestratorView();
		// Not live yet (app start): resumed by id through the spawn, with a
		// plain start to fall back on.
		expect(setPendingTask).toHaveBeenCalledWith(
			"o1",
			expect.objectContaining({
				argv: ["claude", "--resume", "sid-1"],
				fallback: "claude",
			}),
		);
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("orch");
	});

	it("offers to choose a folder when the Orchestrator folder is missing", async () => {
		ensure.mockRejectedValueOnce("Folder not found: /Volumes/ssd/Orchestrator");
		agent.mockResolvedValue(null);
		await enterOrchestratorView();
		expect(useOrchestratorStore.getState()).toMatchObject({
			phase: "error",
			missingFolder: "/Volumes/ssd/Orchestrator",
		});

		// Using the default: Rust moves it, then the Orchestrator starts.
		setFolder.mockResolvedValue({
			path: "/data/orchestrator/P",
			isDefault: true,
		});
		await chooseOrchestratorFolder(null);
		expect(setFolder).toHaveBeenCalledWith(expect.any(String), null);
		expect(useOrchestratorStore.getState()).toMatchObject({
			phase: "pick",
			missingFolder: null,
		});
	});

	it("keeps the card up with the reason when a chosen folder is refused", async () => {
		ensure.mockRejectedValueOnce("Folder not found: /Volumes/ssd/Orchestrator");
		await enterOrchestratorView();
		setFolder.mockRejectedValue("Choose an empty folder");
		await chooseOrchestratorFolder("/Users/me/project");
		expect(useOrchestratorStore.getState()).toMatchObject({
			phase: "error",
			missingFolder: "/Volumes/ssd/Orchestrator",
			error: "Choose an empty folder",
		});
	});

	it("focuses the pane that wants the user when the view opens", async () => {
		const twoTabs = {
			...ws("orch", "orchestrator", {
				type: "terminal",
				id: "o1",
				ptyId: "p-o1",
				agentId: "claude",
				agentHandle: "Orchestrator",
			}),
		};
		twoTabs.tabs = [
			...twoTabs.tabs,
			{
				...twoTabs.tabs[0],
				id: "orch-t2",
				position: 1,
				layoutJson: JSON.stringify({
					type: "terminal",
					id: "h1",
					ptyId: "p-h1",
				}),
			},
		];
		ensure.mockResolvedValue(twoTabs);
		agent.mockResolvedValue("claude");
		const entry = (state: string) => ({ state, detectionMode: "agent" });
		usePtyActivityStore.setState({
			activities: {
				"p-o1": entry("idle"),
				"p-h1": entry("waiting"),
			} as never,
		});
		await enterOrchestratorView();
		// A helper is Waiting: its Tab comes forward and its pane takes focus.
		expect(useWorkspaceStore.getState().activeTabByWorkspace.orch).toBe(
			"orch-t2",
		);
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("h1");
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
			// The Agent reports its session id while it runs.
			setLayout({
				type: "terminal",
				id: "o1",
				ptyId: "",
				agentId: "claude",
				agentHandle: "Orchestrator",
				agentSessionId: "sid-9",
			});
			// The Agent exits: the pane stays, its Agent, handle and id go. The
			// picker waits, so the Agent's last output can be read.
			setLayout({ type: "terminal", id: "o1", ptyId: "" });
			expect(useOrchestratorStore.getState().exited).toBe(false);
			await vi.advanceTimersByTimeAsync(EXIT_PICKER_DELAY_MS + 10);
			expect(useOrchestratorStore.getState().exited).toBe(true);
			expect(setPendingTask).not.toHaveBeenCalled();
			// The same Agent again resumes the conversation it left, by the
			// id remembered while it ran.
			await pickOrchestratorAgent("claude");
			expect(useOrchestratorStore.getState().exited).toBe(false);
			expect(setPendingTask).toHaveBeenCalledWith(
				"o1",
				expect.objectContaining({ argv: ["claude", "--resume", "sid-9"] }),
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

	it("resumes by a remembered id only for the Agent that reported it", async () => {
		useSettingsStore.setState({
			agents: [
				...useSettingsStore.getState().agents,
				{
					id: "codex",
					name: "Codex",
					command: "codex",
					enabled: true,
					resumeArgs: ["resume", "{session}"],
				},
			],
		} as never);
		agent.mockResolvedValue(null);
		useWindowUiStore.setState({ orchestratorViewOpen: false });
		const stop = installOrchestratorSession();
		useWindowUiStore.setState({ orchestratorViewOpen: true });
		await enterOrchestratorView();
		await pickOrchestratorAgent("claude");
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
		try {
			setLayout({
				type: "terminal",
				id: "o1",
				ptyId: "",
				agentId: "claude",
				agentHandle: "Orchestrator",
				agentSessionId: "sid-a",
			});
			setLayout({ type: "terminal", id: "o1", ptyId: "" });
			setPendingTask.mockClear();
			// Another Agent after the exit starts fresh: Claude's id is not its.
			await pickOrchestratorAgent("codex");
			expect(setPendingTask).toHaveBeenLastCalledWith("o1", {
				argv: ["codex"],
				agentId: "codex",
			});
			// Codex exits before reporting an id. Picking Claude now is again a
			// change of Agent, so it starts fresh too, not with Claude's old id.
			setLayout({ type: "terminal", id: "o1", ptyId: "" });
			await pickOrchestratorAgent("claude");
			expect(setPendingTask).toHaveBeenLastCalledWith("o1", {
				argv: ["claude"],
				agentId: "claude",
			});
		} finally {
			stop();
		}
	});

	it("forgets the remembered session when installed for a Profile", () => {
		useOrchestratorStore.setState({
			lastSession: { agentId: "claude", sessionId: "sid-old" },
		});
		useWindowUiStore.setState({ orchestratorViewOpen: false });
		const stop = installOrchestratorSession();
		try {
			expect(useOrchestratorStore.getState().lastSession).toBeNull();
		} finally {
			stop();
		}
	});
});

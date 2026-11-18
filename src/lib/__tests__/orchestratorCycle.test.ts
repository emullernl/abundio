import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode, WorkspaceWithTabs } from "../types";

vi.mock("../terminalManager", () => ({ getTerminal: () => undefined }));
vi.mock("../ipc", async (orig) => ({
	...(await orig<typeof import("../ipc")>()),
	orchestrator: { selectTab: vi.fn(() => Promise.resolve()) },
}));

const { cycleOrchestrator, graphCycleOrder, nextPeekStop } = await import(
	"../orchestratorCycle"
);
const { useOrchestratorStore } = await import("../../stores/orchestratorStore");
const { useWorkspaceStore } = await import("../../stores/workspaceStore");
const { usePtyActivityStore } = await import("../../stores/ptyActivityStore");

describe("the Agent cycle in the Orchestrator view", () => {
	it("goes Orchestrator, then the Agents in graph order, and wraps", () => {
		const order = ["a1", "a2", "h1"];
		expect(nextPeekStop(order, null, 1)).toBe("a1");
		expect(nextPeekStop(order, "a1", 1)).toBe("a2");
		expect(nextPeekStop(order, "h1", 1)).toBeNull();
		expect(nextPeekStop(order, null, -1)).toBe("h1");
		expect(nextPeekStop(order, "a1", -1)).toBeNull();
		// A Peek no longer in the graph counts as the Orchestrator.
		expect(nextPeekStop(order, "gone", 1)).toBe("a1");
		// No Agents at all: only the Orchestrator.
		expect(nextPeekStop([], null, 1)).toBeNull();
	});

	it("takes the graph's order: Workspaces, their Agents, then helpers", () => {
		const agent = (paneId: string) => ({ paneId }) as never;
		expect(
			graphCycleOrder({
				workspaces: [
					{ agents: [agent("a1"), agent("a2")] },
					{ agents: [agent("b1")] },
				] as never,
				helpers: [agent("h1")],
			}),
		).toEqual(["a1", "a2", "b1", "h1"]);
	});
});

describe("cycleOrchestrator", () => {
	const term = (id: string, ptyId: string, extra = {}): PaneNode => ({
		type: "terminal",
		id,
		ptyId,
		...extra,
	});
	const ws = (
		id: string,
		layout: PaneNode,
		kind: "work" | "orchestrator" = "work",
	) =>
		({
			id,
			name: id,
			kind,
			rootFolder: `/${id}`,
			position: 0,
			profileId: "p",
			tabs: [
				{
					id: `${id}-t`,
					workspaceId: id,
					name: "Tab",
					layoutJson: JSON.stringify(layout),
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		}) as unknown as WorkspaceWithTabs;

	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [
				ws("app", term("a1", "p-a1")),
				ws(
					"orch",
					term("o1", "p-o1", { agentHandle: "Orchestrator" }),
					"orchestrator",
				),
			],
			activeWorkspaceId: "orch",
			focusedPaneId: "o1",
		});
		usePtyActivityStore.setState({
			openedWorkspaceIds: new Set(["app"]),
			panePtyMap: {},
			activities: {
				"p-a1": { state: "idle", detectionMode: "agent" },
				"p-o1": { state: "idle", detectionMode: "agent" },
			} as never,
		});
		useOrchestratorStore.setState({
			workspaceId: "orch",
			phase: "ready",
			peekPaneId: null,
			selectedTabId: "file-tab",
			peekFocused: false,
			fileTabFocused: true,
		});
	});

	it("peeks at the next Agent beside the file tab, and hands it the keyboard", () => {
		cycleOrchestrator(1);
		expect(useOrchestratorStore.getState()).toMatchObject({
			peekPaneId: "a1",
			selectedPaneId: "a1",
			// The Peek sits beside a file tab too: the file stays in view.
			selectedTabId: "file-tab",
			peekFocused: true,
			// A file tab gives the keyboard up to the Peek.
			fileTabFocused: false,
		});
	});

	it("lands back on the Orchestrator: the Peek closes and its pane is focused", () => {
		useOrchestratorStore.setState({ peekPaneId: "a1" });
		useWorkspaceStore.setState({ focusedPaneId: "a1" });
		cycleOrchestrator(1);
		expect(useOrchestratorStore.getState().peekPaneId).toBeNull();
		expect(useOrchestratorStore.getState().peekFocused).toBe(false);
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("o1");
	});
});

import { describe, expect, it } from "vitest";
import {
	findOrchestratorWorkspace,
	launchCommand,
	ORCHESTRATOR_HANDLE,
	orchestratorPane,
	paneRunsAgent,
	pickerAgents,
	stampOrchestrator,
	startPane,
} from "../orchestrator";
import { findNode } from "../paneTree";
import type { CodingAgent, PaneNode, Tab } from "../types";

function term(id: string, extra: Partial<PaneNode> = {}): PaneNode {
	return { type: "terminal", id, ptyId: "", ...extra } as PaneNode;
}

function tab(id: string, position: number, layout: PaneNode): Tab {
	return {
		id,
		workspaceId: "o",
		name: id,
		layoutJson: JSON.stringify(layout),
		position,
		createdAt: 0,
		updatedAt: 0,
	};
}

const split = (a: PaneNode, b: PaneNode): PaneNode => ({
	type: "split",
	id: "s",
	direction: "vertical",
	ratio: 0.5,
	first: a,
	second: b,
});

describe("orchestrator helpers", () => {
	it("finds the Profile's Orchestrator workspace only", () => {
		const list = [
			{ id: "a", profileId: "p" },
			{ id: "x", profileId: "q", kind: "orchestrator" },
			{ id: "o", profileId: "p", kind: "orchestrator" },
		];
		expect(findOrchestratorWorkspace(list, "p")?.id).toBe("o");
		expect(findOrchestratorWorkspace(list, "r")).toBeUndefined();
	});

	it("finds the pane carrying the handle, ignoring case", () => {
		const tabs = [
			tab("t1", 0, term("a")),
			tab(
				"t2",
				1,
				split(term("b"), term("c", { agentHandle: "orchestrator" })),
			),
		];
		expect(orchestratorPane(tabs)).toEqual({ tabId: "t2", paneId: "c" });
	});

	it("starts in the handle's pane, else the first terminal of the first Tab", () => {
		expect(
			startPane([tab("t2", 1, term("b")), tab("t1", 0, term("a"))]),
		).toEqual({ tabId: "t1", paneId: "a" });
		expect(
			startPane([
				tab("t1", 0, term("a")),
				tab("t2", 1, term("b", { agentHandle: ORCHESTRATOR_HANDLE })),
			]),
		).toEqual({ tabId: "t2", paneId: "b" });
		expect(
			startPane([tab("t1", 0, { type: "file", id: "f", filePath: "/x" })]),
		).toBeNull();
	});

	it("stamps the Agent and the handle; a new Agent drops the old session", () => {
		const before = term("a", {
			agentId: "codex",
			agentSessionId: "s1",
			agentHandle: ORCHESTRATOR_HANDLE,
		});
		const after = stampOrchestrator(before, "a", "claude");
		const node = findNode(after, "a");
		expect(node).toMatchObject({
			agentId: "claude",
			agentHandle: ORCHESTRATOR_HANDLE,
		});
		expect(node && "agentSessionId" in node).toBe(false);
		expect(paneRunsAgent(after, "a", "claude")).toBe(true);
		expect(paneRunsAgent(after, "a", "codex")).toBe(false);
	});

	it("keeps the session when the same Agent is stamped again", () => {
		const before = term("a", {
			agentId: "claude",
			agentSessionId: "s1",
			agentHandle: ORCHESTRATOR_HANDLE,
		});
		expect(stampOrchestrator(before, "a", "claude")).toBe(before);
	});

	it("offers switched-on Agents, Claude Code first", () => {
		const agents = [
			{ id: "codex", name: "Codex", command: "codex", enabled: true },
			{ id: "gemini", name: "Gemini", command: "gemini", enabled: false },
			{ id: "claude", name: "Claude Code", command: "claude", enabled: true },
		] as CodingAgent[];
		expect(pickerAgents(agents).map((a) => a.id)).toEqual(["claude", "codex"]);
		expect(
			launchCommand({ ...agents[0], args: ["--yolo"] } as CodingAgent),
		).toBe("codex --yolo");
	});
});

import type { PtyActivityState, PtyDetectionMode } from "../types";
import type { WorkspacePane } from "./resolveTarget";
import type { ControlStatus } from "./types";

/** What the Window knows about one pane's PTY, gathered from its stores. */
export interface PaneLiveFacts {
	state: PtyActivityState | null;
	mode: PtyDetectionMode | null;
	exited: boolean;
	/** The Agent's id from detection, when the layout has none yet. */
	detectedAgentId: string | null;
	cwd: string | null;
	title: string | null;
	/** The command running in a shell-mode PTY, if any. */
	runningCommand: string | null;
}

/** One pane as `abundio pane list` / `pane current` print it. */
export interface PaneDescription {
	pane: string;
	number: number;
	handle: string | null;
	tab: string;
	self: boolean;
	mode: "agent" | "shell";
	agent: string | null;
	status: ControlStatus;
	cwd: string | null;
	title: string | null;
	command: string | null;
	spawnedBy: string | null;
}

/** One Agent as `abundio agent list` prints it. */
export interface AgentDescription {
	pane: string;
	number: number;
	handle: string | null;
	tab: string;
	self: boolean;
	agent: string | null;
	status: ControlStatus;
	cwd: string | null;
	title: string | null;
	spawnedBy: string | null;
}

export function paneLabel(n: number): string {
	return `p${n}`;
}

export function controlStatus(facts: PaneLiveFacts): ControlStatus {
	if (facts.exited) return "exited";
	switch (facts.state) {
		case "active":
			return "working";
		case "waiting":
		case "ready":
		case "error":
			return facts.state;
		default:
			return "idle";
	}
}

export function describePane(
	pane: WorkspacePane,
	facts: PaneLiveFacts,
	numbers: ReadonlyMap<string, number>,
	callerPaneId: string,
): PaneDescription {
	const number = numbers.get(pane.node.id) ?? 0;
	const mode = facts.mode === "agent" ? "agent" : "shell";
	const owner = pane.node.spawnedBy
		? numbers.get(pane.node.spawnedBy)
		: undefined;
	return {
		pane: paneLabel(number),
		number,
		handle: pane.node.agentHandle ?? null,
		tab: pane.tabName,
		self: pane.node.id === callerPaneId,
		mode,
		agent:
			mode === "agent"
				? (pane.node.agentId ?? facts.detectedAgentId ?? null)
				: null,
		status: controlStatus(facts),
		cwd: facts.cwd ?? pane.node.cwd ?? null,
		title: facts.title || null,
		command: mode === "shell" ? facts.runningCommand || null : null,
		spawnedBy: owner !== undefined ? paneLabel(owner) : null,
	};
}

export function describeAgent(p: PaneDescription): AgentDescription {
	return {
		pane: p.pane,
		number: p.number,
		handle: p.handle,
		tab: p.tab,
		self: p.self,
		agent: p.agent,
		status: p.status,
		cwd: p.cwd,
		title: p.title,
		spawnedBy: p.spawnedBy,
	};
}

// **Session resume** (ADR-0050): the line typed to relaunch a pane's
// remembered Agent on Workspace open or a Bundle restart.

import { useSettingsStore } from "../stores/settingsStore";
import { agentRelaunchCommandFor } from "./agents";
import type { PaneNode } from "./types";

type TerminalNode = Extract<PaneNode, { type: "terminal" }>;

/**
 * The relaunch line for one pane, from the live settings: its session by id,
 * or the plain command (ADR-0060). Undefined when the pane remembers no
 * Agent, or one that no longer exists.
 */
export function relaunchCommandForPane(node: TerminalNode): string | undefined {
	if (!node.agentId) return undefined;
	const settings = useSettingsStore.getState();
	return agentRelaunchCommandFor(settings.agents, node.agentId, {
		sessionId: node.agentSessionId,
		resume: settings.resumeAgentSessions,
	});
}

/** Terminal leaves of a layout, in tree order. */
export function terminalNodes(node: PaneNode): TerminalNode[] {
	if (node.type === "terminal") return [node];
	if (node.type === "split") {
		return [...terminalNodes(node.first), ...terminalNodes(node.second)];
	}
	return [];
}

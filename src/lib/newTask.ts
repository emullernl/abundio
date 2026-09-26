// Pure decisions behind the **New task** dialog: which panes in a Workspace
// run an Agent, which one **Restart agent** targets, which Agent is picked by
// default, and which **Task destination** is shown. See CONTEXT.md.

import type { PtyActivityEntry } from "../stores/ptyActivityStore";
import type { TaskDestinationPreference } from "../stores/settingsStore";
import { isTaskCapable } from "./agents";
import {
	collectAgentPanes,
	collectTerminalIds,
	parseTabLayout,
} from "./paneTree";
import type { CodingAgent, WorkspaceWithTabs } from "./types";

export type TaskDestination = TaskDestinationPreference;

/** A pane of the Workspace whose PTY is in agent mode right now. */
export interface AgentPane {
	paneId: string;
	tabId: string;
	tabName: string;
	/** Detected from the running process, else the id stamped on the layout. */
	agentId: string | undefined;
	/** Working or Waiting: restarting it would interrupt the user's work. */
	busy: "working" | "waiting" | null;
}

export interface LiveAgentState {
	panePtyMap: Record<string, string>;
	agentPtyIds: Set<string>;
	detectedAgentIds: Record<string, string>;
	activities: Record<string, PtyActivityEntry>;
}

/** Every agent-mode pane of `ws`, in Tab then layout order. */
export function workspaceAgentPanes(
	ws: WorkspaceWithTabs,
	live: LiveAgentState,
): AgentPane[] {
	const out: AgentPane[] = [];
	for (const tab of ws.tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		const stamped = new Map(
			collectAgentPanes(layout).map((p) => [p.paneId, p.agentId]),
		);
		for (const paneId of collectTerminalIds(layout)) {
			const ptyId = live.panePtyMap[paneId];
			if (!ptyId || !live.agentPtyIds.has(ptyId)) continue;
			const state = live.activities[ptyId]?.state;
			out.push({
				paneId,
				tabId: tab.id,
				tabName: tab.name,
				agentId: live.detectedAgentIds[ptyId] ?? stamped.get(paneId),
				busy:
					state === "active"
						? "working"
						: state === "waiting"
							? "waiting"
							: null,
			});
		}
	}
	return out;
}

/**
 * The pane **Restart agent** acts on without asking: the focused pane (or
 * Focused tile) if it runs an Agent, else the Workspace's only agent pane.
 * `null` with several candidates means the dialog shows a picker; with none,
 * Restart agent is unavailable.
 */
export function defaultRestartPane(
	panes: AgentPane[],
	focusedPaneId: string | null,
): AgentPane | null {
	const focused = panes.find((p) => p.paneId === focusedPaneId);
	if (focused) return focused;
	return panes.length === 1 ? panes[0] : null;
}

/**
 * The Agent pre-selected in the dialog: the first of `preferred` (the restart
 * target's Agent, then the Workspace's other running Agents) that can take a
 * Task, else the first Task-capable Agent. `offered` is already filtered to
 * Watched + Task-capable.
 */
export function defaultTaskAgentId(
	offered: CodingAgent[],
	preferred: (string | undefined)[],
): string | undefined {
	const ids = new Set(offered.map((a) => a.id));
	return preferred.find((id) => id && ids.has(id)) ?? offered[0]?.id;
}

/** The Agents New task offers: Watched and Task-capable. */
export function taskAgents(agents: CodingAgent[]): CodingAgent[] {
	return agents.filter((a) => a.enabled && isTaskCapable(a));
}

/**
 * The destination shown when the dialog opens: the remembered one, except
 * that Restart agent falls back to New tab when the Workspace runs no Agent.
 * The fallback is shown, never saved — the preference changes only on an
 * explicit pick.
 */
export function initialDestination(
	remembered: TaskDestinationPreference,
	canRestart: boolean,
): TaskDestination {
	return remembered === "restart" && !canRestart ? "newTab" : remembered;
}

/** `../<repo>.worktrees/<branch with / as ->`, as Add worktree derives it. */
export function defaultWorktreeFolder(repo: string, branch: string): string {
	const slug = branch.replace(/\//g, "-");
	return slug ? `../${repo}.worktrees/${slug}` : "";
}

/**
 * Whether New task can launch through this shell: zsh or bash, matched on
 * the binary name as `pty_manager::detect_shell_type` does (ADR-0042).
 */
export function shellSupportsTasks(shellPath: string): boolean {
	const base = (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase();
	return base.includes("zsh") || base.includes("bash");
}

/**
 * The picked issue as far as the dialog is concerned: only while the search
 * still shows it. A pick hidden by the filter must not be what Start uses —
 * the user would launch an issue they can no longer see.
 */
export function visibleIssue<T extends { number: number }>(
	picked: T | null,
	shown: T[],
): T | null {
	return picked && shown.some((i) => i.number === picked.number)
		? picked
		: null;
}

/**
 * The row an arrow key moves to. `current` is the highlighted row, or -1 when
 * nothing is: the first Down then lands on the first row rather than skipping
 * it. Clamped at both ends; `null` when the list is empty.
 */
export function stepIssueIndex(
	current: number,
	step: 1 | -1,
	count: number,
): number | null {
	if (count === 0) return null;
	if (current < 0) return step === 1 ? 0 : count - 1;
	return Math.max(0, Math.min(count - 1, current + step));
}

// Tracks commands that should be typed into a pane's shell after its PTY
// spawns. Seeded by workspaceStore (createTab / createWorkspace) when the user
// launches a new terminal with an agent, and drained by terminalManager once
// the shell startup buffer has flushed.

interface PendingAgent {
	command: string;
}

const pending = new Map<string, PendingAgent>();
const pendingTasks = new Map<string, PendingTask>();

export function setPendingAgent(paneId: string, payload: PendingAgent): void {
	// The mirror of `setPendingTask`: the last seed wins, never both, or the
	// spawn would run the task's Agent and the flush would type a second one
	// into its TUI.
	pendingTasks.delete(paneId);
	pending.set(paneId, payload);
}

export function takePendingAgent(paneId: string): PendingAgent | undefined {
	const value = pending.get(paneId);
	if (value !== undefined) pending.delete(paneId);
	return value;
}

/**
 * A **New task** launch waiting for its pane's PTY. Unlike a pending agent it
 * is not typed into the shell: it rides the spawn itself (`pty_spawn`'s
 * `task`), so the prompt stays one argv element (ADR-0042). Seeding a task
 * clears any pending typed command for the pane — the task's shell runs the
 * Agent, and typing it again would start a second one.
 */
export interface PendingTask {
	/** The Agent's argv, prompt included (`agentTaskArgvFor`). */
	argv: string[];
	/** **Worktree setup commands**, run before the Agent. */
	setup?: string;
	/** The Agent's id, so the pane enters agent mode as it spawns. */
	agentId: string;
}

export function setPendingTask(paneId: string, task: PendingTask): void {
	pending.delete(paneId);
	pendingTasks.set(paneId, task);
}

export function takePendingTask(paneId: string): PendingTask | undefined {
	const value = pendingTasks.get(paneId);
	if (value !== undefined) pendingTasks.delete(paneId);
	return value;
}

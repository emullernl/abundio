// Tracks commands that should be typed into a pane's shell after its PTY
// spawns. Seeded by workspaceStore (createTab / createWorkspace) when the user
// launches a new terminal with an agent, and drained by terminalManager once
// the shell startup buffer has flushed.

interface PendingAgent {
	command: string;
}

const pending = new Map<string, PendingAgent>();

export function setPendingAgent(paneId: string, payload: PendingAgent): void {
	pending.set(paneId, payload);
}

export function takePendingAgent(paneId: string): PendingAgent | undefined {
	const value = pending.get(paneId);
	if (value !== undefined) pending.delete(paneId);
	return value;
}

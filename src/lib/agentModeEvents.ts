// The two events that bracket the end of an Agent in a PTY — see
// **Agent-mode PTY** and **Session end** in CONTEXT.md.
//
// applyAgentExit — the Agent PROCESS is gone. The only way out of agent mode.
// applySessionEnd — the Agent's *session* ended. Never leaves agent mode.

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { onSessionEnd as trackSessionEnd } from "./agentTurnTracker";

/**
 * The Agent's launching command finished, so the Agent process has exited
 * while the shell survives (/exit, Ctrl+C, a crash). Two signals prove it, and
 * they are mutually exclusive by shell type: shell integration's `command_end`
 * (zsh, bash, PowerShell), and the backend's child-process poll
 * `commandFinished` (every other shell). Drops agent mode and forgets the
 * stamped Agent so it does NOT auto-relaunch next time. Returns whether the PTY
 * was in agent mode, since the caller's shell-mode bookkeeping must then skip.
 */
export function applyAgentExit(ptyId: string, paneId: string): boolean {
	const store = usePtyActivityStore.getState();
	if (store.activities[ptyId]?.detectionMode !== "agent") return false;
	store.clearAgentPty(ptyId);
	useWorkspaceStore.getState().stampAgentOnPane(paneId, undefined);
	return true;
}

/**
 * An Agent's **Session end** hook — mapped to the "sessionReset" transition by
 * agentHookMap. Not a process exit: Claude Code and Copilot both fire it on
 * `/clear`, which starts a new session in the same process, and Copilot's
 * payload says `reason: "user_exit"` for `/clear` and `/exit` alike. So it:
 * - always finalizes the open Turn — applyAgentExit drops agent mode without
 *   doing so, and this hook may land on either side of it;
 * - never leaves agent mode or forgets the stamped Agent — that is
 *   applyAgentExit's job alone;
 * - never ADOPTS agent mode, unlike every other hook: arriving just after the
 *   Agent exited, it must not resurrect it;
 * - still in agent mode (the `/clear` case), lands on Idle rather than Ready:
 *   the user just acted in the pane, so there is nothing unacknowledged.
 */
export function applySessionEnd(ptyId: string): void {
	void trackSessionEnd(ptyId);
	const store = usePtyActivityStore.getState();
	if (store.activities[ptyId]?.detectionMode === "agent") {
		store.applyHookEvent(ptyId, "idle");
	}
}

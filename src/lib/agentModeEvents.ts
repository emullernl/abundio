// The two events that bracket the end of an Agent in a PTY — see
// **Agent-mode PTY** and **Session end** in CONTEXT.md.
//
// applyAgentExit — the Agent PROCESS is gone. The only way out of agent mode.
// applySessionEnd — the Agent's *session* ended. Never leaves agent mode.

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { HookTransition } from "./agentHookMap";
import { onSessionEnd as trackSessionEnd } from "./agentTurnTracker";
import type { PtyDetectionMode } from "./types";

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
	// Gate on what clearAgentPty itself gates on, so `true` always means the
	// PTY really left agent mode.
	if (!store.agentPtyIds.has(ptyId)) return false;
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

/** Whether a PTY's hook listener takes the Session end path. It must be
 *  checked BEFORE adoption: every other hook puts the PTY into agent mode and
 *  stamps the Agent, and a Session end landing just after the Agent exited must
 *  not resurrect it. */
export function isSessionEnd(
	transition: HookTransition,
): transition is "sessionReset" {
	return transition === "sessionReset";
}

/** What a PTY's activity listener does with a child-process poll event (the
 *  backend's stand-in for shell integration, in shells without it).
 *  `commandFinished` in agent mode means the Agent process exited: that is an
 *  agent exit even while `suppressActivity` is set — as for command_end — since
 *  an unfocused pane may never clear the flag. Everything else is shell-mode
 *  bookkeeping, skipped while suppressed and in agent mode. */
export function activityAction(
	activity: "commandStarted" | "commandFinished",
	mode: PtyDetectionMode | undefined,
	suppressed: boolean,
): "agentExit" | "shell" | "ignore" {
	if (activity === "commandFinished" && mode === "agent") return "agentExit";
	if (suppressed || mode !== "shell") return "ignore";
	return "shell";
}

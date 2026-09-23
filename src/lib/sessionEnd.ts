// Handles an Agent's **Session end** hook (CONTEXT.md) — mapped to the
// "sessionReset" transition by agentHookMap.
//
// A Session end is not a process exit. Claude Code and Copilot both fire it on
// `/clear`, which starts a new session in the same process, and Copilot's
// payload says `reason: "user_exit"` for `/clear` and `/exit` alike. So it:
// - always finalizes the open Turn — the shell's command_end drops agent mode
//   without doing so, and this hook may land on either side of it;
// - never leaves agent mode or forgets the stamped Agent — only command_end
//   does that, because only it proves the Agent process is gone;
// - never ADOPTS agent mode, unlike every other hook: arriving just after
//   command_end, it must not resurrect an Agent that has exited;
// - still in agent mode (the `/clear` case), lands on Idle rather than Ready:
//   the user just acted in the pane, so there is nothing unacknowledged.

import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { onSessionEnd as trackSessionEnd } from "./agentTurnTracker";

export function applySessionEnd(ptyId: string): void {
	void trackSessionEnd(ptyId);
	const store = usePtyActivityStore.getState();
	if (store.activities[ptyId]?.detectionMode === "agent") {
		store.applyHookEvent(ptyId, "idle");
	}
}

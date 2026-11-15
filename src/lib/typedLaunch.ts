import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { agentCommandFor } from "./agents";
import { pty } from "./ipc";
import { getTerminal } from "./terminalManager";
import { typedLine } from "./typedLine";

/**
 * A **Typed launch** of an Agent into a pane's live shell, as the Command
 * palette and the pane menu do it: type its launch line and press Enter, put
 * the PTY in agent mode, and stamp the Agent on the pane so it relaunches on
 * the next start. Stamping here, not later from shell integration or a hook,
 * is what makes it relaunch from a shell that reports neither (cmd.exe).
 *
 * Returns false, and does nothing, when the pane has no PTY yet, the Agent is
 * unknown, or the pane is already running an Agent. Typing into a running
 * Agent would only reach its prompt, but the stamp would replace its Agent,
 * forgetting its session and its handle, and it would relaunch as the wrong
 * Agent.
 */
export function typedLaunch(paneId: string, agentId: string): boolean {
	const ptyId = getTerminal(paneId)?.ptyId;
	if (!ptyId) return false;
	const activity = usePtyActivityStore.getState().activities[ptyId];
	if (activity?.detectionMode === "agent") return false;
	const command = agentCommandFor(useSettingsStore.getState().agents, agentId);
	if (!command) return false;
	pty.write(ptyId, typedLine(command)).catch(() => {});
	usePtyActivityStore.getState().setAgentPty(ptyId);
	useWorkspaceStore.getState().stampAgentOnPane(paneId, agentId);
	return true;
}

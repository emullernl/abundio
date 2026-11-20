import { isNotConnectedError } from "../stores/hostLinkStore";
import { useSettingsStore } from "../stores/settingsStore";
import { agentCommandsApi } from "./ipc";
import { isRustStatusAuthority } from "./statusSync";
import type { CodingAgent } from "./types";

/**
 * Rust reads each PTY's shell integration itself (docs/plans/remote-hosts.md
 * phase 6d-4), and a command typed at the prompt starts an Agent when it
 * names one of the user's Agents (`matchTitleToAgent`). Tell it the list now
 * and on every change: the built-ins, custom Agents, and which are enabled.
 * Returns a stop function.
 */
export function startAgentCommandsSync(): () => void {
	if (!isRustStatusAuthority()) return () => {};
	const send = (agents: CodingAgent[]) => {
		agentCommandsApi
			.set(agents.map(({ id, command, enabled }) => ({ id, command, enabled })))
			.catch((e) => {
				if (!isNotConnectedError(e))
					console.warn("[agents] Rust did not take the list", e);
			});
	};
	send(useSettingsStore.getState().agents);
	return useSettingsStore.subscribe((s, prev) => {
		if (s.agents !== prev.agents) send(s.agents);
	});
}

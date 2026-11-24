import { isNotConnectedError } from "../stores/hostLinkStore";
import { useSettingsStore } from "../stores/settingsStore";
import { agentCommandsApi, hostsApi } from "./ipc";
import { isRustStatusAuthority } from "./statusSync";
import type { CodingAgent } from "./types";

/**
 * Rust reads each PTY's shell integration itself (docs/plans/remote-hosts.md
 * phase 6d-4), and a command typed at the prompt starts an Agent when it
 * names one of the user's Agents (`matchTitleToAgent`). Tell it the list now
 * and on every change: the built-ins, custom Agents, and which are enabled,
 * with what the **Watch offer** reads (the Status Hooks setting, the Agents
 * declined with *Never*).
 * Returns a stop function.
 *
 * This computer's list only: a Host builds its own from its Host settings
 * (ADR-0064), so a remote Window sends nothing to its Host.
 */
export function startAgentCommandsSync(): () => void {
	if (!isRustStatusAuthority()) return () => {};
	let remote: boolean | null = null;
	const send = async (s: {
		agents: CodingAgent[];
		agentHooksEnabled: boolean;
		declinedWatchOffers: string[];
	}) => {
		if (remote === null) {
			remote = !!(await hostsApi.remoteProfileForWindow().catch(() => null));
		}
		if (remote) return;
		agentCommandsApi
			.set(
				s.agents.map(({ id, command, enabled }) => ({ id, command, enabled })),
				{
					hooksEnabled: s.agentHooksEnabled,
					declined: s.declinedWatchOffers,
				},
			)
			.catch((e) => {
				if (!isNotConnectedError(e))
					console.warn("[agents] Rust did not take the list", e);
			});
	};
	void send(useSettingsStore.getState());
	return useSettingsStore.subscribe((s, prev) => {
		if (
			s.agents !== prev.agents ||
			s.agentHooksEnabled !== prev.agentHooksEnabled ||
			s.declinedWatchOffers !== prev.declinedWatchOffers
		)
			void send(s);
	});
}

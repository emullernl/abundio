import { create } from "zustand";
import { agentRegistry as agentRegistryApi } from "../lib/ipc";

interface AgentRegistryState {
	installedCommands: Set<string>;
	loaded: boolean;
	loading: boolean;
	load: (commands: string[]) => Promise<void>;
	/** Re-scan `$PATH` regardless of the once-guard, e.g. when the Agents
	 * settings section opens, so a mid-session install shows as installed. */
	reload: (commands: string[]) => Promise<void>;
}

/** The scan currently in flight, if any. Callers that arrive mid-scan join it
 *  rather than returning early: both of them (first-run **Agent seeding** and
 *  the Settings "Match to installed" button) act on `installedCommands` the
 *  moment their promise resolves, and an early return hands them the empty set
 *  the in-flight scan is about to replace. See ADR-0037. */
let inFlight: Promise<void> | null = null;

function scan(
	set: (partial: Partial<AgentRegistryState>) => void,
	commands: string[],
): Promise<void> {
	set({ loading: true });
	inFlight = agentRegistryApi
		.listInstalled(commands)
		.then((installed) => {
			set({
				installedCommands: new Set(installed),
				loaded: true,
				loading: false,
			});
		})
		.catch(() => {
			set({ installedCommands: new Set(), loaded: true, loading: false });
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
	installedCommands: new Set(),
	loaded: false,
	loading: false,

	load: async (commands) => {
		if (get().loaded) return;
		if (inFlight) return inFlight;
		await scan(set, commands);
	},

	reload: async (commands) => {
		if (inFlight) return inFlight;
		await scan(set, commands);
	},
}));

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

async function scan(
	set: (partial: Partial<AgentRegistryState>) => void,
	commands: string[],
): Promise<void> {
	set({ loading: true });
	try {
		const installed = await agentRegistryApi.listInstalled(commands);
		set({
			installedCommands: new Set(installed),
			loaded: true,
			loading: false,
		});
	} catch {
		set({ installedCommands: new Set(), loaded: true, loading: false });
	}
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
	installedCommands: new Set(),
	loaded: false,
	loading: false,

	load: async (commands) => {
		if (get().loaded || get().loading) return;
		await scan(set, commands);
	},

	reload: async (commands) => {
		if (get().loading) return;
		await scan(set, commands);
	},
}));

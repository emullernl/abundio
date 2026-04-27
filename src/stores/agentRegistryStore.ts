import { create } from "zustand";
import { agentRegistry as agentRegistryApi } from "../lib/ipc";

interface AgentRegistryState {
	installedCommands: Set<string>;
	loaded: boolean;
	loading: boolean;
	load: (commands: string[]) => Promise<void>;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
	installedCommands: new Set(),
	loaded: false,
	loading: false,

	load: async (commands) => {
		if (get().loaded || get().loading) return;
		set({ loading: true });
		try {
			const installed = await agentRegistryApi.listInstalled(commands);
			set({ installedCommands: new Set(installed), loaded: true, loading: false });
		} catch {
			set({ installedCommands: new Set(), loaded: true, loading: false });
		}
	},
}));

import { create } from "zustand";
import { devEnvironments as devEnvApi } from "../lib/ipc";
import type { DetectedDevEnvironment } from "../lib/types";

interface DevEnvironmentsState {
	installed: DetectedDevEnvironment[];
	loaded: boolean;
	loading: boolean;
	load: () => Promise<void>;
}

export const useDevEnvironmentsStore = create<DevEnvironmentsState>(
	(set, get) => ({
		installed: [],
		loaded: false,
		loading: false,

		load: async () => {
			if (get().loaded || get().loading) return;
			set({ loading: true });
			try {
				const installed = await devEnvApi.list();
				set({ installed, loaded: true, loading: false });
			} catch {
				// Detection is best-effort — on failure, treat as "none detected"
				// but still mark loaded so the button can render its disabled state.
				set({ installed: [], loaded: true, loading: false });
			}
		},
	}),
);

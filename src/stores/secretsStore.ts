import { create } from "zustand";
import { secrets as secretsApi } from "../lib/ipc";
import type { SecretMeta } from "../lib/types";

/**
 * Secrets-vault store. The source of truth is the backend (SQLite metadata +
 * OS keychain), so this is NOT persisted to localStorage — it just mirrors the
 * fetched metadata and proxies mutations through the `secrets` IPC. Secret
 * values never live here; they stay in the keychain.
 */
interface SecretsState {
	secrets: SecretMeta[];
	loaded: boolean;
	loading: boolean;
	/** Fetch the vault once (no-op if already loaded/loading). */
	load: () => Promise<void>;
	/** Force a re-fetch regardless of the once-guard. */
	reload: () => Promise<void>;
	create: (name: string, value: string, description?: string) => Promise<void>;
	update: (
		id: string,
		updates: { name?: string; description?: string; value?: string },
	) => Promise<void>;
	remove: (id: string) => Promise<void>;
}

async function fetchAll(
	set: (partial: Partial<SecretsState>) => void,
): Promise<void> {
	set({ loading: true });
	try {
		const list = await secretsApi.list();
		set({ secrets: list, loaded: true, loading: false });
	} catch {
		set({ secrets: [], loaded: true, loading: false });
	}
}

export const useSecretsStore = create<SecretsState>((set, get) => ({
	secrets: [],
	loaded: false,
	loading: false,

	load: async () => {
		if (get().loaded || get().loading) return;
		await fetchAll(set);
	},

	reload: async () => {
		if (get().loading) return;
		await fetchAll(set);
	},

	create: async (name, value, description) => {
		await secretsApi.create(name, value, description);
		await fetchAll(set);
	},

	update: async (id, updates) => {
		await secretsApi.update(id, updates);
		await fetchAll(set);
	},

	remove: async (id) => {
		await secretsApi.delete(id);
		await fetchAll(set);
	},
}));

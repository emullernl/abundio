// Per-Workspace Environment Bundles: bundle list, variable metadata, and the
// single revealed plaintext slot.
//
// PLAINTEXT INVARIANT: this store holds at most ONE decrypted value at a time,
// in `revealed`. That is a single slot rather than a map on purpose — it is what
// structurally prevents the settings dialog from accumulating every secret in
// the JS heap as the user clicks around. Everything else here is names, sizes
// and flags.

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { ParsedEnvEntry } from "../lib/dotenvParse";
import type { EnvBundleMeta, EnvVarMeta } from "../lib/ipc";
import { env } from "../lib/ipc";

interface RevealedValue {
	workspaceId: string;
	bundle: string;
	name: string;
	value: string;
}

interface WorkspaceEnvState {
	bundles: EnvBundleMeta[];
	vars: EnvVarMeta[];
	selectedBundle: string;
	/** Non-null when the OS credential store is unavailable, locked or denied. */
	keyError: string | null;
	bytesUsed: number;
	bytesBudget: number;
	loading: boolean;
	/** Last operation's error message, surfaced inline by the section. */
	error: string | null;

	/** The one decrypted value currently on screen. See the invariant above. */
	revealed: RevealedValue | null;

	/** Workspace ids whose INJECTED bundle changed this session — gates the
	 *  "Apply to running terminals" affordance. On-demand bundles are read fresh
	 *  on every `abundio-env` call, so they never need a restart. */
	dirtyInjected: Set<string>;

	load: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle?: string | null,
	) => Promise<void>;
	selectBundle: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle: string,
	) => Promise<void>;
	reveal: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle: string,
		name: string,
	) => Promise<void>;
	clearRevealed: () => void;
	upsert: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle: string,
		name: string,
		value: string,
	) => Promise<boolean>;
	importMany: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle: string,
		entries: ParsedEnvEntry[],
	) => Promise<boolean>;
	remove: (
		workspaceId: string,
		inheritFrom: string | null,
		bundle: string,
		name: string,
	) => Promise<void>;
	createBundle: (
		workspaceId: string,
		inheritFrom: string | null,
		name: string,
	) => Promise<boolean>;
	renameBundle: (
		workspaceId: string,
		inheritFrom: string | null,
		from: string,
		to: string,
	) => Promise<boolean>;
	setInjected: (
		workspaceId: string,
		inheritFrom: string | null,
		name: string,
	) => Promise<void>;
	deleteBundle: (
		workspaceId: string,
		inheritFrom: string | null,
		name: string,
	) => Promise<boolean>;
	retryKey: (workspaceId: string, inheritFrom: string | null) => Promise<void>;
	/** Drop the revealed value and any error. Called when the dialog closes. */
	reset: () => void;
	markInjectedDirty: (workspaceId: string) => void;
	/** Mark dirty only when `bundle` is the injected one — edits to an
	 *  on-demand Bundle change nothing about a running terminal. */
	markDirtyIfInjected: (workspaceId: string, bundle: string) => void;
	clearInjectedDirty: (workspaceId: string) => void;
}

const message = (e: unknown): string =>
	typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

export const useWorkspaceEnvStore = create<WorkspaceEnvState>((set, get) => ({
	bundles: [],
	vars: [],
	selectedBundle: "default",
	keyError: null,
	bytesUsed: 0,
	bytesBudget: 0,
	loading: false,
	error: null,
	revealed: null,
	dirtyInjected: new Set<string>(),

	load: async (workspaceId, inheritFrom, bundle = null) => {
		set({ loading: true });
		try {
			const result = await env.list(workspaceId, inheritFrom, bundle);
			set({
				bundles: result.bundles,
				vars: result.vars,
				selectedBundle: result.selectedBundle,
				keyError: result.keyError,
				bytesUsed: result.bytesUsed,
				bytesBudget: result.bytesBudget,
				loading: false,
			});
		} catch (e) {
			set({ loading: false, error: message(e) });
		}
	},

	selectBundle: async (workspaceId, inheritFrom, bundle) => {
		// Revealing is scoped to one variable; changing bundle drops it.
		set({ revealed: null, selectedBundle: bundle });
		await get().load(workspaceId, inheritFrom, bundle);
	},

	reveal: async (workspaceId, inheritFrom, bundle, name) => {
		try {
			const value = await env.reveal(workspaceId, inheritFrom, bundle, name);
			// Assigning replaces any previously revealed value — the single-slot
			// invariant, enforced here rather than left to callers.
			set({ revealed: { workspaceId, bundle, name, value }, error: null });
		} catch (e) {
			set({ error: message(e) });
		}
	},

	clearRevealed: () => set({ revealed: null }),

	upsert: async (workspaceId, inheritFrom, bundle, name, value) => {
		try {
			await env.upsert(workspaceId, bundle, name, value);
			set({ error: null });
			get().markDirtyIfInjected(workspaceId, bundle);
			await get().load(workspaceId, inheritFrom, bundle);
			return true;
		} catch (e) {
			set({ error: message(e) });
			return false;
		}
	},

	importMany: async (workspaceId, inheritFrom, bundle, entries) => {
		try {
			await env.upsertMany(workspaceId, bundle, entries);
			set({ error: null });
			get().markDirtyIfInjected(workspaceId, bundle);
			await get().load(workspaceId, inheritFrom, bundle);
			return true;
		} catch (e) {
			set({ error: message(e) });
			return false;
		}
	},

	remove: async (workspaceId, inheritFrom, bundle, name) => {
		try {
			await env.remove(workspaceId, bundle, name);
			set({ error: null, revealed: null });
			get().markDirtyIfInjected(workspaceId, bundle);
			await get().load(workspaceId, inheritFrom, bundle);
		} catch (e) {
			set({ error: message(e) });
		}
	},

	createBundle: async (workspaceId, inheritFrom, name) => {
		try {
			await env.createBundle(workspaceId, name);
			set({ error: null });
			await get().load(workspaceId, inheritFrom, name);
			return true;
		} catch (e) {
			set({ error: message(e) });
			return false;
		}
	},

	renameBundle: async (workspaceId, inheritFrom, from, to) => {
		try {
			await env.renameBundle(workspaceId, from, to);
			set({ error: null, revealed: null });
			await get().load(workspaceId, inheritFrom, to);
			return true;
		} catch (e) {
			set({ error: message(e) });
			return false;
		}
	},

	setInjected: async (workspaceId, inheritFrom, name) => {
		try {
			await env.setInjected(workspaceId, name);
			// Which bundle is injected changes what every new PTY receives.
			get().markInjectedDirty(workspaceId);
			set({ error: null });
			await get().load(workspaceId, inheritFrom, name);
		} catch (e) {
			set({ error: message(e) });
		}
	},

	deleteBundle: async (workspaceId, inheritFrom, name) => {
		try {
			const wasInjected = get().bundles.find((b) => b.name === name)?.injected;
			await env.deleteBundle(workspaceId, name);
			if (wasInjected) get().markInjectedDirty(workspaceId);
			set({ error: null, revealed: null });
			await get().load(workspaceId, inheritFrom, null);
			return true;
		} catch (e) {
			set({ error: message(e) });
			return false;
		}
	},

	retryKey: async (workspaceId, inheritFrom) => {
		try {
			await env.retryKey();
		} catch {
			// A failed retry is not an error state of its own — the reload below
			// reports whether the key is available now.
		}
		await get().load(workspaceId, inheritFrom, get().selectedBundle);
	},

	reset: () =>
		set({
			revealed: null,
			error: null,
			bundles: [],
			vars: [],
			keyError: null,
		}),

	markInjectedDirty: (workspaceId) =>
		set((s) => ({ dirtyInjected: new Set(s.dirtyInjected).add(workspaceId) })),

	markDirtyIfInjected: (workspaceId, bundle) => {
		if (get().bundles.find((b) => b.name === bundle)?.injected) {
			get().markInjectedDirty(workspaceId);
		}
	},

	clearInjectedDirty: (workspaceId) =>
		set((s) => {
			const next = new Set(s.dirtyInjected);
			next.delete(workspaceId);
			return { dirtyInjected: next };
		}),
}));

// A spawn-time credential failure must surface even when the settings dialog is
// closed, so the banner is not the only way to learn the feature is degraded.
// Registered at module load, mirroring the other app-wide listeners.
listen<{ workspaceId: string; reason: string }>(
	"env-vars-unavailable",
	(event) => {
		useWorkspaceEnvStore.setState({ keyError: event.payload.reason });
	},
).catch(() => {
	// Not fatal: the dialog's own `env.list` also reports key availability.
});

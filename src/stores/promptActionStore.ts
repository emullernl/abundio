/**
 * **Prompt actions**, loaded from SQLite rather than from `settingsStore`.
 *
 * This is the one app-global thing that is *not* a persisted zustand store, and
 * the reason is ADR-0039: the in-pane popover makes writes frequent and
 * multi-window, and `localStorage` is isolated per Tauri webview, so syncing a
 * list through a broadcast payload loses appends. Here the database is the
 * single source of truth and this store is a cache of it.
 *
 * Every mutation therefore goes **to Rust first** and re-reads. There is no
 * optimistic local edit: the whole point is that this Window's copy is never
 * authoritative.
 */

import { create } from "zustand";
import { promptActions as ipc } from "../lib/ipc";
import {
	type ActionScope,
	fromRow,
	type ParamMetaMap,
	type PromptAction,
	toUpdate,
} from "../lib/promptActions";

interface PromptActionState {
	actions: PromptAction[];
	/** False until the first load resolves. The Action bar renders nothing while
	 *  false, which is the same thing it renders when the list is empty — so a
	 *  cold start never flashes a bar into existence and back out. */
	loaded: boolean;
	error: string | null;

	load: () => Promise<void>;
	createAction: (input: {
		name: string;
		body: string;
		scope?: ActionScope;
		params?: ParamMetaMap;
		showInBar?: boolean;
	}) => Promise<PromptAction | null>;
	updateAction: (
		id: string,
		patch: Partial<Pick<PromptAction, "name" | "body" | "showInBar">> & {
			scope?: ActionScope;
			params?: ParamMetaMap;
		},
	) => Promise<void>;
	deleteAction: (id: string) => Promise<void>;
	reorderActions: (ids: string[]) => Promise<void>;
}

export const usePromptActionStore = create<PromptActionState>((set, get) => ({
	actions: [],
	loaded: false,
	error: null,

	load: async () => {
		try {
			const rows = await ipc.list();
			set({ actions: rows.map(fromRow), loaded: true, error: null });
		} catch (e) {
			// Leave whatever was already loaded in place. A failed refresh should
			// not empty a bar the user is mid-way through using.
			set({ error: String(e), loaded: true });
		}
	},

	createAction: async (input) => {
		try {
			const row = await ipc.create({
				name: input.name,
				body: input.body,
				scopeKind: input.scope?.kind ?? "all",
				scopeAgentIds: input.scope?.kind === "set" ? input.scope.agentIds : [],
				paramsJson: JSON.stringify(input.params ?? {}),
				showInBar: input.showInBar ?? true,
			});
			await get().load();
			return fromRow(row);
		} catch (e) {
			set({ error: String(e) });
			return null;
		}
	},

	updateAction: async (id, patch) => {
		try {
			await ipc.update(id, toUpdate(patch));
			await get().load();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	deleteAction: async (id) => {
		try {
			await ipc.delete(id);
			await get().load();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	reorderActions: async (ids) => {
		try {
			await ipc.reorder(ids);
			await get().load();
		} catch (e) {
			set({ error: String(e) });
		}
	},
}));

/**
 * Subscribe to the app-global change broadcast.
 *
 * Must be called from **every** root that renders Prompt actions — `App.tsx`
 * and `SettingsApp.tsx` both — because Tauri events do not propagate between
 * webview roots (see the multi-window notes in CLAUDE.md).
 */
export function watchPromptActions(): Promise<() => void> {
	return ipc.onChanged(() => {
		void usePromptActionStore.getState().load();
	});
}

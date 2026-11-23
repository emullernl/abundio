import { create } from "zustand";
import { sentByOwnerOf } from "../lib/hostRouting";
import { notes as notesApi } from "../lib/ipc";
import { onSharedFromRust } from "../lib/layoutSync";
import { notesEditorFor } from "../lib/notesEditors";

/**
 * Per-Workspace Notes state.
 *
 * Mirrors the `updateLocal` / debounced-`persist` split used for pane layouts
 * in `workspaceStore` (`updateLayoutLocal` / `persistLayout`): typing updates an
 * in-memory cache instantly and schedules a debounced DB write, so the editor
 * never blocks on IPC and SQLite isn't hammered on every keystroke.
 *
 * Content is an opaque TipTap JSON string (see ADR-0012); this store never
 * parses it. `""` means "no note yet". On this computer a Note is only ever
 * active in one Window (a Profile binds to one Window). On a Host two apps
 * can show it (phase 9): a save in one reaches the other (`note-changed`,
 * `applyRemoteNote`), and the last save wins.
 */

const DEBOUNCE_MS = 500;

/** Pending debounced-save timers, keyed by workspace id. Kept outside the
 *  store so they never trigger re-renders. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface NotesState {
	/** workspace id → TipTap JSON string (`""` = no note yet). */
	contentByWorkspaceId: Record<string, string>;
	/** Workspaces whose note has been fetched at least once this session. */
	loadedWorkspaceIds: Set<string>;

	/** Fetch a workspace's note once and cache it. No-op if already loaded. */
	loadNote: (workspaceId: string) => Promise<void>;
	/** Instant in-memory update + scheduled debounced persist (typing path). */
	updateNoteLocal: (workspaceId: string, content: string) => void;
	/** Write the cached content to the DB immediately (the debounce target). */
	persistNote: (workspaceId: string) => Promise<void>;
	/** Cancel any pending debounce and persist right now (blur / switch / close). */
	flushNote: (workspaceId: string) => Promise<void>;
	/** Drop any pending debounced save without persisting. Call when the
	 *  workspace is being deleted — its note row is cascade-deleted, so a
	 *  pending `notesApi.set` would hit a now-missing FK and error. */
	cancelPendingSave: (workspaceId: string) => void;
	/** Another Window saved this note (phase 9). Ignored while this Window
	 *  has typing of its own waiting to be saved: that save comes after. */
	applyRemoteNote: (workspaceId: string, content: string) => void;
}

export const useNotesStore = create<NotesState>((set, get) => ({
	contentByWorkspaceId: {},
	loadedWorkspaceIds: new Set(),

	loadNote: async (workspaceId) => {
		if (get().loadedWorkspaceIds.has(workspaceId)) return;
		try {
			const content = await notesApi.get(workspaceId);
			set((state) => ({
				contentByWorkspaceId: {
					...state.contentByWorkspaceId,
					[workspaceId]: content,
				},
				loadedWorkspaceIds: new Set(state.loadedWorkspaceIds).add(workspaceId),
			}));
		} catch (error) {
			console.error(`Failed to load note for workspace ${workspaceId}:`, error);
		}
	},

	updateNoteLocal: (workspaceId, content) => {
		set((state) => ({
			contentByWorkspaceId: {
				...state.contentByWorkspaceId,
				[workspaceId]: content,
			},
		}));

		const existing = saveTimers.get(workspaceId);
		if (existing) clearTimeout(existing);
		saveTimers.set(
			workspaceId,
			setTimeout(() => {
				saveTimers.delete(workspaceId);
				get()
					.persistNote(workspaceId)
					.catch(() => {});
			}, DEBOUNCE_MS),
		);
	},

	persistNote: async (workspaceId) => {
		const content = get().contentByWorkspaceId[workspaceId];
		if (content === undefined) return;
		try {
			await notesApi.set(workspaceId, content);
		} catch (error) {
			console.error(
				`Failed to persist note for workspace ${workspaceId}:`,
				error,
			);
		}
	},

	flushNote: async (workspaceId) => {
		const existing = saveTimers.get(workspaceId);
		if (existing) {
			clearTimeout(existing);
			saveTimers.delete(workspaceId);
		}
		await get().persistNote(workspaceId);
	},

	cancelPendingSave: (workspaceId) => {
		const existing = saveTimers.get(workspaceId);
		if (existing) {
			clearTimeout(existing);
			saveTimers.delete(workspaceId);
		}
	},

	applyRemoteNote: (workspaceId, content) => {
		if (saveTimers.has(workspaceId)) return;
		if (get().contentByWorkspaceId[workspaceId] === content) return;
		set((state) => ({
			contentByWorkspaceId: {
				...state.contentByWorkspaceId,
				[workspaceId]: content,
			},
		}));
		// An open editor shows it at once, without saving it back.
		const editor = notesEditorFor(workspaceId);
		if (editor) {
			try {
				editor.commands.setContent(content ? JSON.parse(content) : "", {
					emitUpdate: false,
				});
			} catch (e) {
				console.warn("[notes] cannot show another Window's note", e);
			}
		}
	},
}));

onSharedFromRust<{ workspaceId: string; content: string; fromHost?: string }>(
	"note-changed",
	({ workspaceId, content, fromHost }) => {
		// A Host writes only its own Workspaces' notes (ADR-0065).
		if (!sentByOwnerOf(fromHost, "workspace", workspaceId)) return;
		useNotesStore.getState().applyRemoteNote(workspaceId, content);
	},
);

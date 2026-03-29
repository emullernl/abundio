import { create } from "zustand";
import { fs as fsApi, sessions as sessionsApi } from "../lib/ipc";
import { getLanguage } from "../lib/languageMap";
import type { DirEntry } from "../lib/types";
import { useSessionStore } from "./sessionStore";
import {
	clearEditorStateCache,
	getSerializableEditorState,
	type SerializedEditorState,
} from "../components/FileViewer/CodeEditor";

export interface FileTab {
	id: string;
	sessionId: string;
	filePath: string;
	fileName: string;
	fileType: "text" | "image" | "binary";
	content: string | null;
	mime: string | null;
	isDirty: boolean;
	language: string | null;
	initialEditorState: SerializedEditorState | null;
}

interface ExplorerState {
	fileTabs: FileTab[];
	activeFileTabId: string | null;
	expandedDirs: Record<string, boolean>;
	dirContents: Record<string, DirEntry[]>;

	openFile: (sessionId: string, filePath: string, editorState?: SerializedEditorState | null) => Promise<void>;
	closeFileTab: (tabId: string) => void;
	setActiveFileTab: (tabId: string | null) => void;
	updateFileContent: (tabId: string, content: string) => void;
	saveFile: (tabId: string) => Promise<void>;
	toggleDir: (path: string) => Promise<void>;
	loadDir: (path: string) => Promise<void>;
	refreshDirs: (paths: string[]) => Promise<void>;
	clearSessionFileTabs: (sessionId: string) => void;
}

function buildFileTabsPayload(sessionId: string): string {
	const { fileTabs, activeFileTabId } = useExplorerStore.getState();
	const activeView =
		useSessionStore.getState().activeView[sessionId] ?? "terminal";

	const sessionTabs = fileTabs.filter((t) => t.sessionId === sessionId);
	return JSON.stringify({
		tabs: sessionTabs.map((t) => ({
			id: t.id,
			filePath: t.filePath,
			fileName: t.fileName,
			editorState: getSerializableEditorState(t.id),
		})),
		activeFileTabId: sessionTabs.some((t) => t.id === activeFileTabId)
			? activeFileTabId
			: null,
		activeView,
	});
}

/** Fire-and-forget persist — used during normal operations */
export function persistFileTabs(sessionId: string) {
	const payload = buildFileTabsPayload(sessionId);
	sessionsApi.update(sessionId, { fileTabsJson: payload }).catch(() => {});
}

/** Awaitable persist — used on app close so the IPC completes before destroy */
export async function persistAllFileTabs() {
	const sessions = useSessionStore.getState().sessions;
	await Promise.all(
		sessions.map((s) =>
			sessionsApi.update(s.id, { fileTabsJson: buildFileTabsPayload(s.id) }),
		),
	);
}

interface PersistedFileTab {
	id: string;
	filePath: string;
	fileName: string;
	editorState?: SerializedEditorState | null;
}

interface PersistedFileTabState {
	tabs: PersistedFileTab[];
	activeFileTabId: string | null;
	activeView: "terminal" | "file";
}

export async function restoreFileTabs(
	sessions: { id: string; fileTabsJson: string }[],
) {
	const store = useExplorerStore.getState();
	const sessionStore = useSessionStore.getState();

	for (const s of sessions) {
		try {
			const persisted: PersistedFileTabState = JSON.parse(s.fileTabsJson);
			if (!persisted.tabs?.length) continue;

			for (const tab of persisted.tabs) {
				await store.openFile(s.id, tab.filePath, tab.editorState).catch(() => {});
			}

			// Restore active file tab by matching filePath
			if (persisted.activeFileTabId) {
				const persistedActive = persisted.tabs.find(
					(t) => t.id === persisted.activeFileTabId,
				);
				if (persistedActive) {
					const restored = useExplorerStore
						.getState()
						.fileTabs.find(
							(t) =>
								t.filePath === persistedActive.filePath &&
								t.sessionId === s.id,
						);
					if (restored) {
						useExplorerStore.getState().setActiveFileTab(restored.id);
					}
				}
			}

			// Restore active view
			if (persisted.activeView) {
				sessionStore.setActiveView(s.id, persisted.activeView);
			}
		} catch {
			// Invalid JSON, skip
		}
	}
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
	fileTabs: [],
	activeFileTabId: null,
	expandedDirs: {},
	dirContents: {},

	openFile: async (sessionId, filePath, editorState) => {
		// If already open, just activate it
		const existing = get().fileTabs.find((t) => t.filePath === filePath);
		if (existing) {
			set({ activeFileTabId: existing.id });
			useSessionStore.getState().setActiveView(sessionId, "file");
			return;
		}

		const result = await fsApi.readFile(filePath);

		// Re-check after async gap — a concurrent call may have added it
		const existingAfterRead = get().fileTabs.find(
			(t) => t.filePath === filePath,
		);
		if (existingAfterRead) {
			set({ activeFileTabId: existingAfterRead.id });
			useSessionStore.getState().setActiveView(sessionId, "file");
			return;
		}

		const fileName = filePath.split("/").pop() || "Untitled";
		const ext = fileName.includes(".") ? fileName.split(".").pop() || null : null;

		const tab: FileTab = {
			id: crypto.randomUUID(),
			sessionId,
			filePath,
			fileName,
			fileType: result.fileType,
			content: result.content,
			mime: result.mime,
			isDirty: false,
			language: getLanguage(ext),
			initialEditorState: editorState ?? null,
		};

		set((s) => ({
			fileTabs: [...s.fileTabs, tab],
			activeFileTabId: tab.id,
		}));
		useSessionStore.getState().setActiveView(sessionId, "file");
		persistFileTabs(sessionId);
	},

	closeFileTab: (tabId) => {
		clearEditorStateCache(tabId);
		const closedTab = get().fileTabs.find((t) => t.id === tabId);
		set((s) => {
			const idx = s.fileTabs.findIndex((t) => t.id === tabId);
			const newTabs = s.fileTabs.filter((t) => t.id !== tabId);
			let newActiveId = s.activeFileTabId;

			if (s.activeFileTabId === tabId) {
				if (newTabs.length === 0) {
					newActiveId = null;
					// Switch back to terminal view
					const tab = s.fileTabs[idx];
					if (tab) {
						useSessionStore.getState().setActiveView(tab.sessionId, "terminal");
					}
				} else {
					const newIdx = Math.min(idx, newTabs.length - 1);
					newActiveId = newTabs[newIdx].id;
				}
			}

			return { fileTabs: newTabs, activeFileTabId: newActiveId };
		});
		if (closedTab) {
			persistFileTabs(closedTab.sessionId);
		}
	},

	setActiveFileTab: (tabId) => {
		set({ activeFileTabId: tabId });
		if (tabId) {
			const tab = get().fileTabs.find((t) => t.id === tabId);
			if (tab) {
				useSessionStore.getState().setActiveView(tab.sessionId, "file");
				persistFileTabs(tab.sessionId);
			}
		}
	},

	updateFileContent: (tabId, content) => {
		set((s) => ({
			fileTabs: s.fileTabs.map((t) =>
				t.id === tabId ? { ...t, content, isDirty: true } : t,
			),
		}));
	},

	saveFile: async (tabId) => {
		const tab = get().fileTabs.find((t) => t.id === tabId);
		if (!tab || !tab.content || tab.fileType !== "text") return;

		await fsApi.writeFile(tab.filePath, tab.content);
		set((s) => ({
			fileTabs: s.fileTabs.map((t) =>
				t.id === tabId ? { ...t, isDirty: false } : t,
			),
		}));
	},

	toggleDir: async (path) => {
		const expanded = get().expandedDirs[path];
		if (expanded) {
			set((s) => ({
				expandedDirs: { ...s.expandedDirs, [path]: false },
			}));
		} else {
			await get().loadDir(path);
			set((s) => ({
				expandedDirs: { ...s.expandedDirs, [path]: true },
			}));
		}
	},

	loadDir: async (path) => {
		const entries = await fsApi.listDir(path);
		set((s) => ({
			dirContents: { ...s.dirContents, [path]: entries },
		}));
	},

	refreshDirs: async (paths) => {
		const { dirContents } = get();
		// Only refresh directories that are currently loaded
		const toRefresh = paths.filter((p) => p in dirContents);
		if (toRefresh.length === 0) return;

		const results = await Promise.all(
			toRefresh.map(async (p) => {
				const entries = await fsApi.listDir(p);
				return [p, entries] as const;
			}),
		);

		set((s) => {
			const updated = { ...s.dirContents };
			for (const [p, entries] of results) {
				updated[p] = entries;
			}
			return { dirContents: updated };
		});
	},

	clearSessionFileTabs: (sessionId) => {
		set((s) => {
			const newTabs = s.fileTabs.filter((t) => t.sessionId !== sessionId);
			const activeStillExists = newTabs.some((t) => t.id === s.activeFileTabId);
			return {
				fileTabs: newTabs,
				activeFileTabId: activeStillExists ? s.activeFileTabId : null,
			};
		});
	},
}));

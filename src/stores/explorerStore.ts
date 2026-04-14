import { create } from "zustand";
import {
	clearEditorStateCache,
	getSerializableEditorState,
	type SerializedEditorState,
} from "../components/FileViewer/CodeEditor";
import {
	fs as fsApi,
	git as gitApi,
	workspaces as workspacesApi,
} from "../lib/ipc";
import { getLanguage } from "../lib/languageMap";
import type { DirEntry, GitChangedFile } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";

export interface FileTab {
	id: string;
	workspaceId: string;
	filePath: string;
	fileName: string;
	fileType: "text" | "image" | "binary" | "diff";
	content: string | null;
	mime: string | null;
	isDirty: boolean;
	language: string | null;
	initialEditorState: SerializedEditorState | null;
	// Diff-specific fields (only set when fileType === "diff")
	diffOriginal: string | null;
	diffModified: string | null;
	diffSection: GitChangedFile["section"] | null;
	// External-change tracking (file changed on disk while open)
	externallyChanged: boolean;
	deletedOnDisk: boolean;
}

interface ExplorerState {
	fileTabs: FileTab[];
	activeFileTabId: string | null;
	expandedDirs: Record<string, boolean>;
	dirContents: Record<string, DirEntry[]>;
	pendingGotoLine: { filePath: string; line: number } | null;

	openFile: (
		workspaceId: string,
		filePath: string,
		editorState?: SerializedEditorState | null,
	) => Promise<void>;
	openDiff: (
		workspaceId: string,
		filePath: string,
		original: string,
		modified: string,
		section?: GitChangedFile["section"] | null,
	) => void;
	closeFileTab: (tabId: string) => void;
	setActiveFileTab: (tabId: string | null) => void;
	updateFileContent: (tabId: string, content: string) => void;
	saveFile: (tabId: string) => Promise<void>;
	toggleDir: (path: string) => Promise<void>;
	loadDir: (path: string) => Promise<void>;
	refreshDirs: (paths: string[]) => Promise<void>;
	clearWorkspaceFileTabs: (workspaceId: string) => void;
	setPendingGotoLine: (
		target: { filePath: string; line: number } | null,
	) => void;
	handleFsChange: (
		workspaceId: string,
		changedFiles: string[],
		removedFiles: string[],
	) => Promise<void>;
	reloadTabFromDisk: (tabId: string) => Promise<void>;
	dismissExternalChange: (tabId: string) => void;
}

function buildFileTabsPayload(workspaceId: string): string {
	const { fileTabs, activeFileTabId } = useExplorerStore.getState();
	const activeView =
		useWorkspaceStore.getState().activeView[workspaceId] ?? "terminal";

	const workspaceTabs = fileTabs.filter(
		(t) => t.workspaceId === workspaceId && t.fileType !== "diff",
	);
	return JSON.stringify({
		tabs: workspaceTabs.map((t) => ({
			id: t.id,
			filePath: t.filePath,
			fileName: t.fileName,
			editorState: getSerializableEditorState(t.id),
		})),
		activeFileTabId: workspaceTabs.some((t) => t.id === activeFileTabId)
			? activeFileTabId
			: null,
		activeView,
	});
}

/** Fire-and-forget persist — used during normal operations */
export function persistFileTabs(workspaceId: string) {
	const payload = buildFileTabsPayload(workspaceId);
	workspacesApi.update(workspaceId, { fileTabsJson: payload }).catch(() => {});
}

/** Awaitable persist — used on app close so the IPC completes before destroy */
export async function persistAllFileTabs() {
	const workspaces = useWorkspaceStore.getState().workspaces;
	await Promise.all(
		workspaces.map((s) =>
			workspacesApi.update(s.id, { fileTabsJson: buildFileTabsPayload(s.id) }),
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
	workspaces: { id: string; fileTabsJson: string }[],
) {
	const store = useExplorerStore.getState();
	const workspaceStore = useWorkspaceStore.getState();

	for (const s of workspaces) {
		try {
			const persisted: PersistedFileTabState = JSON.parse(s.fileTabsJson);
			if (!persisted.tabs?.length) continue;

			for (const tab of persisted.tabs) {
				await store
					.openFile(s.id, tab.filePath, tab.editorState)
					.catch(() => {});
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
								t.workspaceId === s.id,
						);
					if (restored) {
						useExplorerStore.getState().setActiveFileTab(restored.id);
					}
				}
			}

			// Restore active view
			if (persisted.activeView) {
				workspaceStore.setActiveView(s.id, persisted.activeView);
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
	pendingGotoLine: null,

	openFile: async (workspaceId, filePath, editorState) => {
		// If already open, just activate it
		const existing = get().fileTabs.find((t) => t.filePath === filePath);
		if (existing) {
			set({ activeFileTabId: existing.id });
			useWorkspaceStore.getState().setActiveView(workspaceId, "file");
			return;
		}

		const result = await fsApi.readFile(filePath);

		// Re-check after async gap — a concurrent call may have added it
		const existingAfterRead = get().fileTabs.find(
			(t) => t.filePath === filePath,
		);
		if (existingAfterRead) {
			set({ activeFileTabId: existingAfterRead.id });
			useWorkspaceStore.getState().setActiveView(workspaceId, "file");
			return;
		}

		const fileName = filePath.split("/").pop() || "Untitled";
		const ext = fileName.includes(".")
			? fileName.split(".").pop() || null
			: null;

		const tab: FileTab = {
			id: crypto.randomUUID(),
			workspaceId,
			filePath,
			fileName,
			fileType: result.fileType,
			content: result.content,
			mime: result.mime,
			isDirty: false,
			language: getLanguage(ext),
			initialEditorState: editorState ?? null,
			diffOriginal: null,
			diffModified: null,
			diffSection: null,
			externallyChanged: false,
			deletedOnDisk: false,
		};

		set((s) => ({
			fileTabs: [...s.fileTabs, tab],
			activeFileTabId: tab.id,
		}));
		useWorkspaceStore.getState().setActiveView(workspaceId, "file");
		persistFileTabs(workspaceId);
	},

	openDiff: (workspaceId, filePath, original, modified, section) => {
		// Use a unique key so the same file can be open as both a regular tab and a diff tab
		const diffKey = `diff:${filePath}`;
		const existing = get().fileTabs.find(
			(t) => t.filePath === diffKey && t.workspaceId === workspaceId,
		);
		if (existing) {
			// Update the diff content and activate
			set((s) => ({
				fileTabs: s.fileTabs.map((t) =>
					t.id === existing.id
						? {
								...t,
								diffOriginal: original,
								diffModified: modified,
								diffSection: section ?? t.diffSection,
								externallyChanged: false,
								deletedOnDisk: false,
							}
						: t,
				),
				activeFileTabId: existing.id,
			}));
			useWorkspaceStore.getState().setActiveView(workspaceId, "file");
			return;
		}

		const fileName = filePath.split("/").pop() || "Untitled";
		const ext = fileName.includes(".")
			? fileName.split(".").pop() || null
			: null;

		const tab: FileTab = {
			id: crypto.randomUUID(),
			workspaceId,
			filePath: diffKey,
			fileName: `${fileName} (diff)`,
			fileType: "diff",
			content: null,
			mime: null,
			isDirty: false,
			language: getLanguage(ext),
			initialEditorState: null,
			diffOriginal: original,
			diffModified: modified,
			diffSection: section ?? null,
			externallyChanged: false,
			deletedOnDisk: false,
		};

		set((s) => ({
			fileTabs: [...s.fileTabs, tab],
			activeFileTabId: tab.id,
		}));
		useWorkspaceStore.getState().setActiveView(workspaceId, "file");
	},

	closeFileTab: (tabId) => {
		clearEditorStateCache(tabId);
		const closedTab = get().fileTabs.find((t) => t.id === tabId);
		set((s) => {
			const idx = s.fileTabs.findIndex((t) => t.id === tabId);
			const newTabs = s.fileTabs.filter((t) => t.id !== tabId);
			let newActiveId = s.activeFileTabId;

			if (s.activeFileTabId === tabId) {
				const closedWorkspaceId = s.fileTabs[idx]?.workspaceId;
				const workspaceTabs = newTabs.filter(
					(t) => t.workspaceId === closedWorkspaceId,
				);
				if (workspaceTabs.length === 0) {
					newActiveId = null;
					// Switch back to terminal view
					if (closedWorkspaceId) {
						useWorkspaceStore
							.getState()
							.setActiveView(closedWorkspaceId, "terminal");
					}
				} else {
					const oldIdx = s.fileTabs
						.slice(0, idx)
						.filter((t) => t.workspaceId === closedWorkspaceId).length;
					const newIdx = Math.min(oldIdx, workspaceTabs.length - 1);
					newActiveId = workspaceTabs[newIdx].id;
				}
			}

			return { fileTabs: newTabs, activeFileTabId: newActiveId };
		});
		if (closedTab) {
			persistFileTabs(closedTab.workspaceId);
		}
	},

	setActiveFileTab: (tabId) => {
		set({ activeFileTabId: tabId });
		if (tabId) {
			const tab = get().fileTabs.find((t) => t.id === tabId);
			if (tab) {
				useWorkspaceStore.getState().setActiveView(tab.workspaceId, "file");
				persistFileTabs(tab.workspaceId);
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
		if (!tab?.content || tab.fileType !== "text") return;

		await fsApi.writeFile(tab.filePath, tab.content);
		set((s) => ({
			fileTabs: s.fileTabs.map((t) =>
				t.id === tabId
					? {
							...t,
							isDirty: false,
							externallyChanged: false,
							deletedOnDisk: false,
						}
					: t,
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

		const results = await Promise.allSettled(
			toRefresh.map(async (p) => {
				const entries = await fsApi.listDir(p);
				return [p, entries] as const;
			}),
		);

		set((s) => {
			const updated = { ...s.dirContents };
			for (const result of results) {
				if (result.status === "fulfilled") {
					const [p, entries] = result.value;
					updated[p] = entries;
				}
			}
			return { dirContents: updated };
		});
	},

	clearWorkspaceFileTabs: (workspaceId) => {
		set((s) => {
			const newTabs = s.fileTabs.filter((t) => t.workspaceId !== workspaceId);
			const activeStillExists = newTabs.some((t) => t.id === s.activeFileTabId);
			return {
				fileTabs: newTabs,
				activeFileTabId: activeStillExists ? s.activeFileTabId : null,
			};
		});
	},

	setPendingGotoLine: (target) => set({ pendingGotoLine: target }),

	handleFsChange: async (workspaceId, changedFiles, removedFiles) => {
		const changedSet = new Set(changedFiles);
		const removedSet = new Set(removedFiles);
		if (changedSet.size === 0 && removedSet.size === 0) return;

		const tabs = get().fileTabs.filter((t) => t.workspaceId === workspaceId);

		// ── Deletions ───────────────────────────────────────────────
		for (const tab of tabs) {
			const realPath =
				tab.fileType === "diff"
					? tab.filePath.slice("diff:".length)
					: tab.filePath;
			if (!removedSet.has(realPath)) continue;
			set((s) => ({
				fileTabs: s.fileTabs.map((t) =>
					t.id === tab.id ? { ...t, deletedOnDisk: true } : t,
				),
			}));
		}

		// ── Changes ─────────────────────────────────────────────────
		// Snapshot workspace now — used for diff-tab refresh.
		const workspace = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === workspaceId);

		for (const tab of tabs) {
			const realPath =
				tab.fileType === "diff"
					? tab.filePath.slice("diff:".length)
					: tab.filePath;
			if (!changedSet.has(realPath)) continue;
			// If the same path was also removed in this batch, deletion wins.
			if (removedSet.has(realPath)) continue;

			if (tab.fileType === "text") {
				try {
					const result = await fsApi.readFile(tab.filePath);
					// Re-fetch the tab; state may have changed during the await.
					const current = get().fileTabs.find((t) => t.id === tab.id);
					if (!current) continue;

					// Self-save guard — disk matches what we already show.
					if (result.content === current.content) {
						if (current.externallyChanged || current.deletedOnDisk) {
							set((s) => ({
								fileTabs: s.fileTabs.map((t) =>
									t.id === tab.id
										? { ...t, externallyChanged: false, deletedOnDisk: false }
										: t,
								),
							}));
						}
						continue;
					}

					if (current.isDirty) {
						// Don't clobber unsaved edits — flag for the banner.
						set((s) => ({
							fileTabs: s.fileTabs.map((t) =>
								t.id === tab.id
									? { ...t, externallyChanged: true, deletedOnDisk: false }
									: t,
							),
						}));
					} else {
						// Clean tab: silently reload.
						set((s) => ({
							fileTabs: s.fileTabs.map((t) =>
								t.id === tab.id
									? {
											...t,
											content: result.content,
											mime: result.mime,
											fileType: result.fileType,
											externallyChanged: false,
											deletedOnDisk: false,
										}
									: t,
							),
						}));
					}
				} catch {
					// Read failed (likely a transient rename) — leave the tab alone.
				}
			} else if (tab.fileType === "diff") {
				// Re-run the git diff for this file. Requires cwd + section.
				if (!workspace || !tab.diffSection) continue;
				try {
					const diff = await gitApi.fileDiff(
						workspace.rootFolder,
						realPath,
						tab.diffSection,
						workspace.baseBranch,
					);
					set((s) => ({
						fileTabs: s.fileTabs.map((t) =>
							t.id === tab.id
								? {
										...t,
										diffOriginal: diff.original,
										diffModified: diff.modified,
										externallyChanged: false,
										deletedOnDisk: false,
									}
								: t,
						),
					}));
				} catch {
					// Diff command failed (file no longer tracked, etc.) — ignore.
				}
			}
		}
	},

	reloadTabFromDisk: async (tabId) => {
		const tab = get().fileTabs.find((t) => t.id === tabId);
		if (!tab || tab.fileType !== "text") return;
		try {
			const result = await fsApi.readFile(tab.filePath);
			set((s) => ({
				fileTabs: s.fileTabs.map((t) =>
					t.id === tabId
						? {
								...t,
								content: result.content,
								mime: result.mime,
								fileType: result.fileType,
								isDirty: false,
								externallyChanged: false,
								deletedOnDisk: false,
							}
						: t,
				),
			}));
		} catch {
			// Read failed — leave tab as-is.
		}
	},

	dismissExternalChange: (tabId) => {
		set((s) => ({
			fileTabs: s.fileTabs.map((t) =>
				t.id === tabId
					? { ...t, externallyChanged: false, deletedOnDisk: false }
					: t,
			),
		}));
	},
}));

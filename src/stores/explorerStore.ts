import { create } from "zustand";
import {
	clearEditorStateCache,
	getSerializableEditorState,
} from "../components/FileViewer/CodeEditor";
import { fs as fsApi, git as gitApi } from "../lib/ipc";
import { getLanguage } from "../lib/languageMap";
import {
	collectPaneIds,
	findFilePaneByPath,
	findNode,
	wrapInSplit,
} from "../lib/paneTree";
import type { DirEntry, GitChangedFile, PaneNode } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";

// Cache to survive unregisterFilePane calls (React Strict Mode unmount/remount and
// async updateLayout causing filePath prop changes). Keyed by paneId.
const diffContentCache = new Map<
	string,
	{ original: string; modified: string; filePath: string }
>();

// ── FilePaneState — runtime state for a file leaf, keyed by paneId ──

export interface FilePaneState {
	filePath: string;
	fileName: string;
	fileType: "text" | "image" | "binary" | "diff";
	content: string | null;
	mime: string | null;
	isDirty: boolean;
	language: string | null;
	externallyChanged: boolean;
	deletedOnDisk: boolean;
	loading: boolean;
	// Diff-specific fields
	diffOriginal: string | null;
	diffModified: string | null;
	diffSection: GitChangedFile["section"] | null;
}

function makeEmptyPaneState(filePath: string): FilePaneState {
	const fileName = filePath.split("/").pop() || "Untitled";
	const ext = fileName.includes(".") ? fileName.split(".").pop() || null : null;
	return {
		filePath,
		fileName,
		fileType: "text",
		content: null,
		mime: null,
		isDirty: false,
		language: getLanguage(ext),
		externallyChanged: false,
		deletedOnDisk: false,
		loading: true,
		diffOriginal: null,
		diffModified: null,
		diffSection: null,
	};
}

interface ExplorerState {
	filePanes: Record<string, FilePaneState>; // paneId → state
	expandedDirs: Record<string, boolean>;
	dirContents: Record<string, DirEntry[]>;
	pendingGotoLine: { filePath: string; line: number } | null;
	pendingEdit: PendingEditMode | null;

	// Called by FilePane on mount — triggers content load
	registerFilePane: (
		paneId: string,
		filePath: string,
		isDiff?: boolean,
		diffSection?: GitChangedFile["section"] | null,
		diffOriginal?: string | null,
		diffModified?: string | null,
	) => void;
	// Called by FilePane on unmount
	unregisterFilePane: (paneId: string) => void;
	// Clears all file pane state for a workspace (used on workspace close)
	clearWorkspaceFilePanes: (workspaceId: string) => void;

	// Navigates to a file by updating the layout (or creating a new tab)
	openFile: (workspaceId: string, filePath: string) => Promise<void>;
	openDiff: (
		workspaceId: string,
		filePath: string,
		original: string,
		modified: string,
		section?: GitChangedFile["section"] | null,
	) => void;

	// Inline create / rename in the file tree
	startCreate: (parentDir: string, kind: "file" | "folder") => void;
	startRename: (targetPath: string, isDir: boolean) => void;
	cancelEdit: () => void;
	commitEdit: (name: string) => Promise<void>;

	// Open a file by splitting the focused pane in the given direction
	openFileInSplit: (
		workspaceId: string,
		filePath: string,
		direction: "horizontal" | "vertical",
	) => Promise<void>;

	updateFileContent: (paneId: string, content: string) => void;
	saveFile: (paneId: string) => Promise<void>;

	toggleDir: (path: string) => Promise<void>;
	loadDir: (path: string) => Promise<void>;
	refreshDirs: (paths: string[]) => Promise<void>;

	setPendingGotoLine: (
		target: { filePath: string; line: number } | null,
	) => void;
	handleFsChange: (
		workspaceId: string,
		changedFiles: string[],
		removedFiles: string[],
	) => Promise<void>;

	reloadPaneFromDisk: (paneId: string) => Promise<void>;
	reloadTabFromDisk: (paneId: string) => Promise<void>; // alias for compat
	dismissExternalChange: (paneId: string) => void;

	// Legacy compat helpers — these have no effect but prevent import errors
	// during the transition period. They will be removed in a follow-up.
	closeFileTab: (paneId: string) => void;
	setActiveFileTab: (paneId: string | null) => void;
}

// ── Pending edit state for inline create / rename in the file tree ──

export type PendingEditMode =
	| { kind: "create"; type: "file" | "folder"; parentDir: string }
	| {
			kind: "rename";
			targetPath: string;
			isDir: boolean;
			initialName: string;
	  };

// ── Internal helpers ──

function getActiveTabLayout(workspaceId: string): {
	tabId: string;
	layout: PaneNode;
} | null {
	const wsStore = useWorkspaceStore.getState();
	const workspace = wsStore.workspaces.find((w) => w.id === workspaceId);
	const tabId = wsStore.activeTabByWorkspace[workspaceId];
	const tab = workspace?.tabs.find((t) => t.id === tabId);
	if (!tab) return null;
	try {
		return { tabId, layout: JSON.parse(tab.layoutJson) as PaneNode };
	} catch {
		return null;
	}
}

function renameFileInLayout(
	node: PaneNode,
	oldPath: string,
	newPath: string,
): PaneNode {
	if (node.type === "file") {
		if (node.filePath === oldPath) return { ...node, filePath: newPath };
		const diffKey = `diff:${oldPath}`;
		if (node.filePath === diffKey)
			return { ...node, filePath: `diff:${newPath}` };
		return node;
	}
	if (node.type === "terminal") return node;
	const first = renameFileInLayout(node.first, oldPath, newPath);
	const second = renameFileInLayout(node.second, oldPath, newPath);
	if (first === node.first && second === node.second) return node;
	return { ...node, first, second };
}

async function loadFilePaneContent(paneId: string, filePath: string) {
	const store = useExplorerStore.getState();
	// Guard: pane may have unmounted
	if (!store.filePanes[paneId]) return;

	try {
		const result = await fsApi.readFile(filePath);
		useExplorerStore.setState((s) => {
			if (!s.filePanes[paneId]) return s;
			return {
				filePanes: {
					...s.filePanes,
					[paneId]: {
						...s.filePanes[paneId],
						fileType: result.fileType,
						content: result.content,
						mime: result.mime,
						loading: false,
					},
				},
			};
		});
	} catch {
		// Read failed — mark not loading
		useExplorerStore.setState((s) => {
			if (!s.filePanes[paneId]) return s;
			return {
				filePanes: {
					...s.filePanes,
					[paneId]: { ...s.filePanes[paneId], loading: false },
				},
			};
		});
	}
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
	filePanes: {},
	expandedDirs: {},
	dirContents: {},
	pendingGotoLine: null,
	pendingEdit: null,

	registerFilePane: (
		paneId,
		filePath,
		isDiff,
		diffSection,
		diffOriginal,
		diffModified,
	) => {
		const existing = get().filePanes[paneId];
		// If already registered for same file, no-op
		if (existing && existing.filePath === filePath) return;

		if (isDiff) {
			const realPath = filePath.startsWith("diff:")
				? filePath.slice("diff:".length)
				: filePath;
			const ext = realPath.includes(".")
				? realPath.split(".").pop() || null
				: null;
			const fileName = `${realPath.split("/").pop() || "file"} (diff)`;
			// Recover diff content from cache (survives unregisterFilePane due to
			// React Strict Mode unmount/remount or async layout updates).
			const cached = diffContentCache.get(paneId);
			if (cached?.filePath === filePath) diffContentCache.delete(paneId);
			const resolvedOriginal =
				diffOriginal ?? (cached?.filePath === filePath ? cached.original : null);
			const resolvedModified =
				diffModified ?? (cached?.filePath === filePath ? cached.modified : null);
			set((s) => ({
				filePanes: {
					...s.filePanes,
					[paneId]: {
						filePath,
						fileName,
						fileType: "diff",
						content: null,
						mime: null,
						isDirty: false,
						language: getLanguage(ext),
						externallyChanged: false,
						deletedOnDisk: false,
						loading: false,
						diffOriginal: resolvedOriginal,
						diffModified: resolvedModified,
						diffSection: diffSection ?? null,
					},
				},
			}));
		} else {
			set((s) => ({
				filePanes: {
					...s.filePanes,
					[paneId]: makeEmptyPaneState(filePath),
				},
			}));
			loadFilePaneContent(paneId, filePath);
		}
	},

	unregisterFilePane: (paneId) => {
		const pane = get().filePanes[paneId];
		if (
			pane?.fileType === "diff" &&
			pane.diffOriginal != null &&
			pane.diffModified != null
		) {
			diffContentCache.set(paneId, {
				original: pane.diffOriginal,
				modified: pane.diffModified,
				filePath: pane.filePath,
			});
		}
		clearEditorStateCache(paneId);
		set((s) => {
			const { [paneId]: _removed, ...rest } = s.filePanes;
			return { filePanes: rest };
		});
	},

	clearWorkspaceFilePanes: (workspaceId) => {
		// Clear all file pane states that belong to this workspace's tabs
		const wsStore = useWorkspaceStore.getState();
		const workspace = wsStore.workspaces.find((w) => w.id === workspaceId);
		if (!workspace) return;
		const paneIdsToRemove = new Set<string>();
		for (const tab of workspace.tabs) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				for (const id of collectPaneIds(layout)) {
					paneIdsToRemove.add(id);
				}
			} catch {
				// ignore
			}
		}
		set((s) => {
			const filePanes = { ...s.filePanes };
			for (const id of paneIdsToRemove) {
				clearEditorStateCache(id);
				delete filePanes[id];
			}
			return { filePanes, pendingEdit: null };
		});
	},

	openFile: async (workspaceId, filePath) => {
		const seedLayout: PaneNode = {
			type: "file",
			id: crypto.randomUUID(),
			filePath,
		};
		await useWorkspaceStore
			.getState()
			.createTab(workspaceId, undefined, seedLayout);
	},

	openDiff: (workspaceId, filePath, original, modified, section) => {
		const diffKey = `diff:${filePath}`;

		const ctx = getActiveTabLayout(workspaceId);
		const wsStore = useWorkspaceStore.getState();

		// Check if diff pane already exists
		if (ctx) {
			const existing = findFilePaneByPath(ctx.layout, diffKey);
			if (existing) {
				// Update diff content and focus
				set((s) => ({
					filePanes: {
						...s.filePanes,
						[existing.id]: {
							...s.filePanes[existing.id],
							diffOriginal: original,
							diffModified: modified,
							diffSection: section ?? null,
						},
					},
				}));
				wsStore.setFocusedPane(existing.id);
				return;
			}
		}

		// Seed diff content eagerly so FilePane has it when it mounts
		const newPaneId = crypto.randomUUID();
		const realPath = filePath;
		const ext = realPath.includes(".")
			? realPath.split(".").pop() || null
			: null;
		set((s) => ({
			filePanes: {
				...s.filePanes,
				[newPaneId]: {
					filePath: diffKey,
					fileName: `${realPath.split("/").pop() || "file"} (diff)`,
					fileType: "diff",
					content: null,
					mime: null,
					isDirty: false,
					language: getLanguage(ext),
					externallyChanged: false,
					deletedOnDisk: false,
					loading: false,
					diffOriginal: original,
					diffModified: modified,
					diffSection: section ?? null,
				},
			},
		}));

		const seedLayout: PaneNode = {
			type: "file",
			id: newPaneId,
			filePath: diffKey,
			isDiff: true,
			diffSection: section || undefined,
		};

		// Always open diff in a new tab
		useWorkspaceStore
			.getState()
			.createTab(workspaceId, undefined, seedLayout)
			.catch(() => {});
	},

	startCreate: async (parentDir, kind) => {
		const { expandedDirs, loadDir } = get();
		if (!expandedDirs[parentDir]) {
			await loadDir(parentDir);
			set((s) => ({
				expandedDirs: { ...s.expandedDirs, [parentDir]: true },
			}));
		}
		set({ pendingEdit: { kind: "create", type: kind, parentDir } });
	},

	startRename: (targetPath, isDir) => {
		const { dirContents } = get();
		const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
		const entries = dirContents[parentDir] ?? [];
		const entry = entries.find((e) => e.path === targetPath);
		const initialName = entry?.name ?? targetPath.split("/").pop() ?? "";
		set({
			pendingEdit: { kind: "rename", targetPath, isDir, initialName },
		});
	},

	cancelEdit: () => set({ pendingEdit: null }),

	commitEdit: async (name) => {
		const trimmed = name.trim();
		const { pendingEdit } = get();
		if (!pendingEdit) return;

		// Validate: empty or contains path separators
		if (!trimmed || /[/\\:]/.test(trimmed)) {
			set({ pendingEdit: null });
			return;
		}

		try {
			if (pendingEdit.kind === "create") {
				const { parentDir, type } = pendingEdit;
				const newPath = `${parentDir}/${trimmed}`;
				if (type === "file") {
					await fsApi.createFile(newPath);
				} else {
					await fsApi.createFolder(newPath);
				}
				await get().refreshDirs([parentDir]);
			} else {
				// rename
				const { targetPath, initialName } = pendingEdit;
				if (trimmed === initialName) {
					set({ pendingEdit: null });
					return;
				}
				const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
				const newPath = `${parentDir}/${trimmed}`;
				await fsApi.rename(targetPath, newPath);
				await get().refreshDirs([parentDir]);

				// Update any open file panes pointing at the old path
				set((s) => {
					const updatedPanes: Record<string, FilePaneState> = {};
					for (const [paneId, pane] of Object.entries(s.filePanes)) {
						const realPath = pane.filePath.startsWith("diff:")
							? pane.filePath.slice("diff:".length)
							: pane.filePath;
						if (realPath === targetPath) {
							const isDiffPane = pane.filePath.startsWith("diff:");
							updatedPanes[paneId] = {
								...pane,
								filePath: isDiffPane ? `diff:${newPath}` : newPath,
								fileName: trimmed,
								deletedOnDisk: false,
							};
						} else {
							updatedPanes[paneId] = pane;
						}
					}
					return { filePanes: updatedPanes };
				});

				// Update pane layouts in all workspaces so file leaves reflect new path
				const wsStore = useWorkspaceStore.getState();
				for (const workspace of wsStore.workspaces) {
					for (const tab of workspace.tabs) {
						try {
							const layout = JSON.parse(tab.layoutJson) as PaneNode;
							const updated = renameFileInLayout(layout, targetPath, newPath);
							if (updated !== layout) {
								wsStore.updateLayout(tab.id, updated).catch(() => {});
							}
						} catch {
							// ignore malformed layout
						}
					}
				}
			}
		} finally {
			set({ pendingEdit: null });
		}
	},

	openFileInSplit: async (workspaceId, filePath, direction) => {
		const ctx = getActiveTabLayout(workspaceId);
		const wsStore = useWorkspaceStore.getState();
		const focusedPaneId = wsStore.focusedPaneId;

		if (!ctx || !focusedPaneId || !findNode(ctx.layout, focusedPaneId)) {
			// Fall back to opening as a new tab
			await get().openFile(workspaceId, filePath);
			return;
		}

		const newPaneId = crypto.randomUUID();
		const newLeaf: PaneNode = { type: "file", id: newPaneId, filePath };
		const newLayout = wrapInSplit(
			ctx.layout,
			focusedPaneId,
			newLeaf,
			direction,
		);
		await wsStore.updateLayout(ctx.tabId, newLayout);
		wsStore.setFocusedPane(newPaneId);
	},

	updateFileContent: (paneId, content) => {
		set((s) => {
			const pane = s.filePanes[paneId];
			if (!pane) return s;
			return {
				filePanes: {
					...s.filePanes,
					[paneId]: { ...pane, content, isDirty: true },
				},
			};
		});
	},

	saveFile: async (paneId) => {
		const pane = get().filePanes[paneId];
		if (!pane?.content || pane.fileType !== "text") return;

		await fsApi.writeFile(pane.filePath, pane.content);
		set((s) => {
			const p = s.filePanes[paneId];
			if (!p) return s;
			return {
				filePanes: {
					...s.filePanes,
					[paneId]: {
						...p,
						isDirty: false,
						externallyChanged: false,
						deletedOnDisk: false,
					},
				},
			};
		});
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

	setPendingGotoLine: (target) => set({ pendingGotoLine: target }),

	handleFsChange: async (workspaceId, changedFiles, removedFiles) => {
		const changedSet = new Set(changedFiles);
		const removedSet = new Set(removedFiles);
		if (changedSet.size === 0 && removedSet.size === 0) return;

		const { filePanes } = get();
		// Only look at panes belonging to this workspace
		const wsStore = useWorkspaceStore.getState();
		const workspace = wsStore.workspaces.find((w) => w.id === workspaceId);
		const workspacePaneIds = new Set<string>();
		for (const tab of workspace?.tabs ?? []) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				for (const id of collectPaneIds(layout)) workspacePaneIds.add(id);
			} catch {
				// ignore
			}
		}

		for (const [paneId, pane] of Object.entries(filePanes)) {
			if (!workspacePaneIds.has(paneId)) continue;

			const realPath =
				pane.fileType === "diff"
					? pane.filePath.startsWith("diff:")
						? pane.filePath.slice("diff:".length)
						: pane.filePath
					: pane.filePath;

			// ── Deletions ──
			if (removedSet.has(realPath)) {
				set((s) => ({
					filePanes: {
						...s.filePanes,
						[paneId]: { ...s.filePanes[paneId], deletedOnDisk: true },
					},
				}));
				continue;
			}

			// ── Changes ──
			if (!changedSet.has(realPath)) continue;

			if (pane.fileType === "text") {
				try {
					const result = await fsApi.readFile(pane.filePath);
					const current = get().filePanes[paneId];
					if (!current) continue;

					if (result.content === current.content) {
						if (current.externallyChanged || current.deletedOnDisk) {
							set((s) => ({
								filePanes: {
									...s.filePanes,
									[paneId]: {
										...s.filePanes[paneId],
										externallyChanged: false,
										deletedOnDisk: false,
									},
								},
							}));
						}
						continue;
					}

					if (current.isDirty) {
						set((s) => ({
							filePanes: {
								...s.filePanes,
								[paneId]: {
									...s.filePanes[paneId],
									externallyChanged: true,
									deletedOnDisk: false,
								},
							},
						}));
					} else {
						// Clean tab: silently reload
						set((s) => ({
							filePanes: {
								...s.filePanes,
								[paneId]: {
									...s.filePanes[paneId],
									content: result.content,
									mime: result.mime,
									fileType: result.fileType,
									externallyChanged: false,
									deletedOnDisk: false,
								},
							},
						}));
					}
				} catch {
					// Transient read failure — leave as-is
				}
			} else if (pane.fileType === "diff") {
				if (!pane.diffSection) continue;
				try {
					const diff = await gitApi.fileDiff(
						workspace?.rootFolder ?? "",
						realPath,
						pane.diffSection,
						workspace?.baseBranch ?? null,
					);
					set((s) => ({
						filePanes: {
							...s.filePanes,
							[paneId]: {
								...s.filePanes[paneId],
								diffOriginal: diff.original,
								diffModified: diff.modified,
								externallyChanged: false,
								deletedOnDisk: false,
							},
						},
					}));
				} catch {
					// ignore
				}
			}
		}
	},

	reloadPaneFromDisk: async (paneId) => {
		const pane = get().filePanes[paneId];
		if (!pane || pane.fileType !== "text") return;
		try {
			const result = await fsApi.readFile(pane.filePath);
			set((s) => ({
				filePanes: {
					...s.filePanes,
					[paneId]: {
						...s.filePanes[paneId],
						content: result.content,
						mime: result.mime,
						fileType: result.fileType,
						isDirty: false,
						externallyChanged: false,
						deletedOnDisk: false,
					},
				},
			}));
		} catch {
			// ignore
		}
	},

	reloadTabFromDisk: async (paneId) => get().reloadPaneFromDisk(paneId),

	dismissExternalChange: (paneId) => {
		set((s) => {
			const pane = s.filePanes[paneId];
			if (!pane) return s;
			return {
				filePanes: {
					...s.filePanes,
					[paneId]: { ...pane, externallyChanged: false, deletedOnDisk: false },
				},
			};
		});
	},

	// Legacy compat — kept for callers that haven't been updated yet
	closeFileTab: (paneId) => get().unregisterFilePane(paneId),
	setActiveFileTab: (_paneId) => {
		// No-op: focus is now tracked via workspaceStore.focusedPaneId
	},
}));

// ── Persistence helpers ──

/** Persist editor state into the active tab's layout for all open file panes. */
export async function persistAllFilePanes() {
	const wsStore = useWorkspaceStore.getState();
	const tabsApi = (await import("../lib/ipc")).tabs;
	for (const workspace of wsStore.workspaces) {
		for (const tab of workspace.tabs) {
			try {
				const layout = JSON.parse(tab.layoutJson) as PaneNode;
				// Persist editor state into each file leaf's layout node
				let mutated = false;
				const persist = (node: PaneNode): PaneNode => {
					if (node.type === "file") {
						const state = getSerializableEditorState(node.id);
						if (state) {
							mutated = true;
							return { ...node, _editorState: state } as PaneNode;
						}
						return node;
					}
					if (node.type === "terminal") return node;
					return {
						...node,
						first: persist(node.first),
						second: persist(node.second),
					};
				};
				const updated = persist(layout);
				if (mutated) {
					tabsApi
						.update(tab.id, { layoutJson: JSON.stringify(updated) })
						.catch(() => {});
				}
			} catch {
				// ignore
			}
		}
	}
}

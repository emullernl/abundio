import { create } from "zustand";
import { fs as fsApi } from "../lib/ipc";
import { getLanguage } from "../lib/languageMap";
import type { DirEntry } from "../lib/types";
import { useSessionStore } from "./sessionStore";

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
}

interface ExplorerState {
	fileTabs: FileTab[];
	activeFileTabId: string | null;
	expandedDirs: Record<string, boolean>;
	dirContents: Record<string, DirEntry[]>;

	openFile: (sessionId: string, filePath: string) => Promise<void>;
	closeFileTab: (tabId: string) => void;
	setActiveFileTab: (tabId: string | null) => void;
	updateFileContent: (tabId: string, content: string) => void;
	saveFile: (tabId: string) => Promise<void>;
	toggleDir: (path: string) => Promise<void>;
	loadDir: (path: string) => Promise<void>;
	clearSessionFileTabs: (sessionId: string) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
	fileTabs: [],
	activeFileTabId: null,
	expandedDirs: {},
	dirContents: {},

	openFile: async (sessionId, filePath) => {
		// If already open, just activate it
		const existing = get().fileTabs.find((t) => t.filePath === filePath);
		if (existing) {
			set({ activeFileTabId: existing.id });
			useSessionStore.getState().setActiveView(sessionId, "file");
			return;
		}

		const result = await fsApi.readFile(filePath);
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
		};

		set((s) => ({
			fileTabs: [...s.fileTabs, tab],
			activeFileTabId: tab.id,
		}));
		useSessionStore.getState().setActiveView(sessionId, "file");
	},

	closeFileTab: (tabId) => {
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
	},

	setActiveFileTab: (tabId) => {
		set({ activeFileTabId: tabId });
		if (tabId) {
			const tab = get().fileTabs.find((t) => t.id === tabId);
			if (tab) {
				useSessionStore.getState().setActiveView(tab.sessionId, "file");
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

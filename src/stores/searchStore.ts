import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fs as fsApi } from "../lib/ipc";
import type { SearchFileResult } from "../lib/types";

let searchGeneration = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface SearchState {
	query: string;
	caseSensitive: boolean;
	isRegex: boolean;
	wholeWord: boolean;
	includePattern: string;
	excludePattern: string;
	showFilters: boolean;

	results: SearchFileResult[];
	totalMatches: number;
	truncated: boolean;
	loading: boolean;
	error: string | null;
	collapsedFiles: Record<string, boolean>;
	currentSearchId: string | null;

	setQuery: (q: string, rootPath: string | null) => void;
	setCaseSensitive: (v: boolean, rootPath: string | null) => void;
	setIsRegex: (v: boolean, rootPath: string | null) => void;
	setWholeWord: (v: boolean, rootPath: string | null) => void;
	setIncludePattern: (v: string, rootPath: string | null) => void;
	setExcludePattern: (v: string, rootPath: string | null) => void;
	toggleFilters: () => void;
	executeSearch: (rootPath: string) => Promise<void>;
	cancelSearch: () => void;
	toggleFileCollapsed: (filePath: string) => void;
	clear: () => void;
}

function scheduleSearch(rootPath: string | null) {
	if (debounceTimer) clearTimeout(debounceTimer);
	if (!rootPath) return;
	debounceTimer = setTimeout(() => {
		useSearchStore.getState().executeSearch(rootPath);
	}, 300);
}

export const useSearchStore = create<SearchState>()(
	persist(
		(set, get) => ({
			query: "",
			caseSensitive: false,
			isRegex: false,
			wholeWord: false,
			includePattern: "",
			excludePattern: "",
			showFilters: false,

			results: [],
			totalMatches: 0,
			truncated: false,
			loading: false,
			error: null,
			collapsedFiles: {},
			currentSearchId: null,

			setQuery: (query, rootPath) => {
				set({ query });
				scheduleSearch(rootPath);
			},
			setCaseSensitive: (caseSensitive, rootPath) => {
				set({ caseSensitive });
				scheduleSearch(rootPath);
			},
			setIsRegex: (isRegex, rootPath) => {
				set({ isRegex });
				scheduleSearch(rootPath);
			},
			setWholeWord: (wholeWord, rootPath) => {
				set({ wholeWord });
				scheduleSearch(rootPath);
			},
			setIncludePattern: (includePattern, rootPath) => {
				set({ includePattern });
				scheduleSearch(rootPath);
			},
			setExcludePattern: (excludePattern, rootPath) => {
				set({ excludePattern });
				scheduleSearch(rootPath);
			},
			toggleFilters: () => set((s) => ({ showFilters: !s.showFilters })),

			executeSearch: async (rootPath) => {
				const state = get();
				if (!state.query.trim()) {
					set({
						results: [],
						totalMatches: 0,
						truncated: false,
						loading: false,
						error: null,
					});
					return;
				}

				// Cancel previous search
				if (state.currentSearchId) {
					fsApi.searchCancel(state.currentSearchId).catch(() => {});
				}

				const gen = ++searchGeneration;
				const searchId = crypto.randomUUID();
				set({ loading: true, error: null, currentSearchId: searchId });

				try {
					const result = await fsApi.search({
						rootPath,
						query: state.query,
						caseSensitive: state.caseSensitive,
						isRegex: state.isRegex,
						wholeWord: state.wholeWord,
						includePattern: state.includePattern || null,
						excludePattern: state.excludePattern || null,
						searchId,
					});

					if (gen !== searchGeneration) return;

					set({
						results: result.files,
						totalMatches: result.totalMatches,
						truncated: result.truncated,
						loading: false,
						error: null,
						collapsedFiles: {},
					});
				} catch (err) {
					if (gen !== searchGeneration) return;
					set({
						results: [],
						totalMatches: 0,
						truncated: false,
						loading: false,
						error: String(err),
					});
				}
			},

			cancelSearch: () => {
				const { currentSearchId } = get();
				if (currentSearchId) {
					fsApi.searchCancel(currentSearchId).catch(() => {});
				}
				searchGeneration++;
				set({ loading: false, currentSearchId: null });
			},

			toggleFileCollapsed: (filePath) =>
				set((s) => ({
					collapsedFiles: {
						...s.collapsedFiles,
						[filePath]: !s.collapsedFiles[filePath],
					},
				})),

			clear: () => {
				searchGeneration++;
				if (debounceTimer) clearTimeout(debounceTimer);
				set({
					query: "",
					results: [],
					totalMatches: 0,
					truncated: false,
					loading: false,
					error: null,
					collapsedFiles: {},
					currentSearchId: null,
				});
			},
		}),
		{
			name: "abundio-search",
			partialize: (state) => ({
				caseSensitive: state.caseSensitive,
				isRegex: state.isRegex,
				wholeWord: state.wholeWord,
				showFilters: state.showFilters,
			}),
		},
	),
);

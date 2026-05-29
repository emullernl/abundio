import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fs as fsApi } from "../lib/ipc";
import type { SearchFileResult } from "../lib/types";

let searchGeneration = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hard ceiling on the total number of matches the UI will hold/render. Mirrors
 * the backend's `DEFAULT_MAX_RESULTS`, but is enforced on the frontend too: the
 * parallel walker can briefly overshoot its own cap, and the final response may
 * carry that overshoot — so we trim here to keep the DOM bounded regardless.
 */
export const MAX_SEARCH_RESULTS = 5_000;

// Streamed matches are buffered and flushed once per animation frame, so a burst
// of backend events becomes one React render instead of thousands.
let streamBuffer: SearchFileResult[] = [];
let streamFlushHandle: number | null = null;

function resetStreamBatch() {
	if (streamFlushHandle !== null) {
		cancelAnimationFrame(streamFlushHandle);
		streamFlushHandle = null;
	}
	streamBuffer = [];
}

/**
 * Append `incoming` files onto `existing` while never exceeding `limit` total
 * matches. The file that crosses the limit has its `matches` trimmed so the
 * rendered row count is exactly bounded. Returns the new list + running total.
 */
function appendCapped(
	existing: SearchFileResult[],
	startTotal: number,
	incoming: SearchFileResult[],
	limit: number,
): { results: SearchFileResult[]; total: number; truncated: boolean } {
	const results = existing.slice();
	let total = startTotal;
	let truncated = false;
	for (const file of incoming) {
		if (total >= limit) {
			truncated = true;
			break;
		}
		const room = limit - total;
		if (file.matches.length > room) {
			results.push({ ...file, matches: file.matches.slice(0, room) });
			total = limit;
			truncated = true;
		} else {
			results.push(file);
			total += file.matches.length;
		}
	}
	return { results, total, truncated };
}

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
	/** Workspace root the current results were computed against (null if none). */
	searchedRoot: string | null;

	setQuery: (q: string, rootPath: string | null) => void;
	setCaseSensitive: (v: boolean, rootPath: string | null) => void;
	setIsRegex: (v: boolean, rootPath: string | null) => void;
	setWholeWord: (v: boolean, rootPath: string | null) => void;
	setIncludePattern: (v: string, rootPath: string | null) => void;
	setExcludePattern: (v: string, rootPath: string | null) => void;
	toggleFilters: () => void;
	executeSearch: (rootPath: string) => Promise<void>;
	/** Re-point the search at a new workspace root, dropping stale results. */
	rescope: (rootPath: string | null) => void;
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
			searchedRoot: null,

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
						searchedRoot: rootPath,
					});
					return;
				}

				// Cancel previous search
				if (state.currentSearchId) {
					fsApi.searchCancel(state.currentSearchId).catch(() => {});
				}

				const gen = ++searchGeneration;
				const searchId = crypto.randomUUID();
				resetStreamBatch();
				set({
					loading: true,
					error: null,
					currentSearchId: searchId,
					searchedRoot: rootPath,
					// Reset the list up front so streamed matches accumulate cleanly.
					results: [],
					totalMatches: 0,
					truncated: false,
					collapsedFiles: {},
				});

				// Buffer streamed files and flush once per frame, so results populate
				// while the walk runs without re-rendering the list on every event.
				const unlisten = await fsApi.onSearchProgress(searchId, (file) => {
					if (gen !== searchGeneration) return;
					// Once the cap is hit, stop buffering — no point growing the list
					// or scheduling frames the flush will only discard.
					if (get().totalMatches >= MAX_SEARCH_RESULTS) return;
					streamBuffer.push(file);
					if (streamFlushHandle !== null) return;
					streamFlushHandle = requestAnimationFrame(() => {
						streamFlushHandle = null;
						if (gen !== searchGeneration) {
							streamBuffer = [];
							return;
						}
						const batch = streamBuffer;
						streamBuffer = [];
						set((s) => {
							const { results, total, truncated } = appendCapped(
								s.results,
								s.totalMatches,
								batch,
								MAX_SEARCH_RESULTS,
							);
							return {
								results,
								totalMatches: total,
								truncated: s.truncated || truncated,
							};
						});
					});
				});

				try {
					const result = await fsApi.search({
						rootPath,
						query: state.query,
						caseSensitive: state.caseSensitive,
						isRegex: state.isRegex,
						wholeWord: state.wholeWord,
						includePattern: state.includePattern || null,
						excludePattern: state.excludePattern || null,
						maxResults: MAX_SEARCH_RESULTS,
						searchId,
					});

					if (gen !== searchGeneration) return;

					// Drop any buffered/pending streamed files so the final replace
					// below isn't clobbered by a trailing animation-frame flush.
					resetStreamBatch();

					// Replace the streamed (arrival-order) list with the authoritative
					// sorted result, capped in case the backend overshot the limit.
					const capped = appendCapped([], 0, result.files, MAX_SEARCH_RESULTS);
					set({
						results: capped.results,
						totalMatches: capped.total,
						truncated: result.truncated || capped.truncated,
						loading: false,
						error: null,
						collapsedFiles: {},
					});
				} catch (err) {
					if (gen !== searchGeneration) return;
					resetStreamBatch();
					set({
						results: [],
						totalMatches: 0,
						truncated: false,
						loading: false,
						error: String(err),
					});
				} finally {
					unlisten();
				}
			},

			rescope: (rootPath) => {
				const state = get();
				// Already pointed at this root — keep results as-is.
				if (state.searchedRoot === rootPath) return;

				// Drop the previous workspace's in-flight search and stale results.
				if (state.currentSearchId) {
					fsApi.searchCancel(state.currentSearchId).catch(() => {});
				}
				if (debounceTimer) clearTimeout(debounceTimer);
				searchGeneration++;
				resetStreamBatch();
				set({
					results: [],
					totalMatches: 0,
					truncated: false,
					loading: false,
					error: null,
					collapsedFiles: {},
					currentSearchId: null,
					searchedRoot: rootPath,
				});

				// Re-run the existing query in the new workspace context.
				if (rootPath && state.query.trim()) {
					get().executeSearch(rootPath);
				}
			},

			cancelSearch: () => {
				const { currentSearchId } = get();
				if (currentSearchId) {
					fsApi.searchCancel(currentSearchId).catch(() => {});
				}
				searchGeneration++;
				resetStreamBatch();
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
				resetStreamBatch();
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

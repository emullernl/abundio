import { beforeEach, describe, expect, it, vi } from "vitest";

const { search, searchCancel, onSearchProgress } = vi.hoisted(() => ({
	search: vi.fn(),
	searchCancel: vi.fn(),
	onSearchProgress: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
	fs: { search, searchCancel, onSearchProgress },
}));

/** Let pending microtasks (the awaited onSearchProgress + search) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Let a queued animation frame (the batched stream flush) run, then settle. */
const flushFrame = () =>
	new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

import { MAX_SEARCH_RESULTS, useSearchStore } from "../searchStore";

/** Build a file result with `n` synthetic matches. */
const fileWithMatches = (path: string, n: number) => ({
	filePath: path,
	matches: Array.from({ length: n }, (_, i) => ({
		lineNumber: i + 1,
		lineContent: "hit",
		matchStart: 0,
		matchEnd: 3,
	})),
});

const emptyResult = {
	files: [],
	totalMatches: 0,
	truncated: false,
};

function resetStore() {
	useSearchStore.setState({
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
	});
}

describe("searchStore.rescope", () => {
	beforeEach(() => {
		resetStore();
		vi.clearAllMocks();
		search.mockResolvedValue(emptyResult);
		searchCancel.mockResolvedValue(undefined);
		onSearchProgress.mockResolvedValue(() => {});
	});

	it("no-ops when the root is unchanged so results survive a panel toggle", () => {
		const fileResult = { filePath: "/repo/a.ts", matches: [] };
		useSearchStore.setState({
			query: "foo",
			searchedRoot: "/repo",
			results: [fileResult],
			totalMatches: 3,
		});

		useSearchStore.getState().rescope("/repo");

		const state = useSearchStore.getState();
		expect(state.results).toEqual([fileResult]);
		expect(state.totalMatches).toBe(3);
		expect(search).not.toHaveBeenCalled();
	});

	it("clears stale results when switching to a new workspace root", () => {
		useSearchStore.setState({
			query: "",
			searchedRoot: "/repo-a",
			results: [{ filePath: "/repo-a/a.ts", matches: [] }],
			totalMatches: 5,
			truncated: true,
		});

		useSearchStore.getState().rescope("/repo-b");

		const state = useSearchStore.getState();
		expect(state.results).toEqual([]);
		expect(state.totalMatches).toBe(0);
		expect(state.truncated).toBe(false);
		expect(state.searchedRoot).toBe("/repo-b");
		// No active query, so no new search is issued.
		expect(search).not.toHaveBeenCalled();
	});

	it("re-runs the existing query against the new root", async () => {
		useSearchStore.setState({ query: "needle", searchedRoot: "/repo-a" });

		useSearchStore.getState().rescope("/repo-b");
		await flush();

		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0][0]).toMatchObject({
			rootPath: "/repo-b",
			query: "needle",
		});
		expect(useSearchStore.getState().searchedRoot).toBe("/repo-b");
	});

	it("cancels an in-flight search from the previous workspace", () => {
		useSearchStore.setState({
			query: "needle",
			searchedRoot: "/repo-a",
			currentSearchId: "search-123",
		});

		useSearchStore.getState().rescope("/repo-b");

		expect(searchCancel).toHaveBeenCalledWith("search-123");
	});
});

describe("searchStore.executeSearch streaming", () => {
	beforeEach(() => {
		resetStore();
		vi.clearAllMocks();
		searchCancel.mockResolvedValue(undefined);
		onSearchProgress.mockResolvedValue(() => {});
	});

	it("appends files as they stream in before the search resolves", async () => {
		useSearchStore.setState({ query: "needle" });

		const streamed = { filePath: "/repo/b.ts", matches: [{}, {}] };
		// Invoke the progress callback as if the backend emitted a match.
		onSearchProgress.mockImplementation(
			async (_id: string, cb: (file: unknown) => void) => {
				cb(streamed);
				return () => {};
			},
		);
		// Keep the final response pending so we can assert the streamed state.
		let resolveSearch: (v: unknown) => void = () => {};
		search.mockReturnValue(
			new Promise((resolve) => {
				resolveSearch = resolve;
			}),
		);

		const promise = useSearchStore.getState().executeSearch("/repo");
		await flush(); // let executeSearch reach the awaited search() call
		await flushFrame(); // run the batched stream flush

		// Mid-flight: streamed file is visible while still loading.
		let state = useSearchStore.getState();
		expect(state.loading).toBe(true);
		expect(state.results).toEqual([streamed]);
		expect(state.totalMatches).toBe(2);

		// Final authoritative (sorted) result replaces the streamed list.
		const finalFile = { filePath: "/repo/a.ts", matches: [{}, {}] };
		resolveSearch({
			files: [finalFile, streamed],
			totalMatches: 4,
			truncated: false,
		});
		await promise;

		state = useSearchStore.getState();
		expect(state.loading).toBe(false);
		expect(state.results).toEqual([finalFile, streamed]);
		expect(state.totalMatches).toBe(4);
	});

	it("trims streamed matches to the hard cap and flags truncation", async () => {
		useSearchStore.setState({ query: "needle" });

		// One oversized file plus another that should be dropped entirely.
		const big = fileWithMatches("/repo/huge.min.js", MAX_SEARCH_RESULTS + 50);
		const extra = fileWithMatches("/repo/after.ts", 5);
		onSearchProgress.mockImplementation(
			async (_id: string, cb: (file: unknown) => void) => {
				cb(big);
				cb(extra);
				return () => {};
			},
		);
		search.mockReturnValue(new Promise(() => {})); // never resolves

		useSearchStore.getState().executeSearch("/repo");
		await flush();
		await flushFrame();

		const state = useSearchStore.getState();
		expect(state.totalMatches).toBe(MAX_SEARCH_RESULTS);
		expect(state.truncated).toBe(true);
		// The crossing file is trimmed; the trailing file is excluded.
		expect(state.results).toHaveLength(1);
		expect(state.results[0].matches).toHaveLength(MAX_SEARCH_RESULTS);
	});

	it("passes the hard cap as maxResults to the backend", async () => {
		useSearchStore.setState({ query: "needle" });
		search.mockResolvedValue(emptyResult);

		useSearchStore.getState().executeSearch("/repo");
		await flush();

		expect(search.mock.calls[0][0]).toMatchObject({
			maxResults: MAX_SEARCH_RESULTS,
		});
	});

	it("cancelSearch stops the walk but keeps results already populated", () => {
		const partial = [
			{
				filePath: "/repo/a.ts",
				matches: [
					{ lineNumber: 1, lineContent: "hit", matchStart: 0, matchEnd: 3 },
				],
			},
		];
		useSearchStore.setState({
			loading: true,
			currentSearchId: "search-abc",
			results: partial,
			totalMatches: 1,
		});

		useSearchStore.getState().cancelSearch();

		const state = useSearchStore.getState();
		expect(searchCancel).toHaveBeenCalledWith("search-abc");
		expect(state.loading).toBe(false);
		expect(state.currentSearchId).toBeNull();
		// Results streamed in so far are preserved.
		expect(state.results).toEqual(partial);
		expect(state.totalMatches).toBe(1);
	});
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flattenSearchRows, SEARCH_ROW_HEIGHT } from "../../lib/searchRows";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSearchStore } from "../../stores/searchStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	CaseSensitive,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	Regex,
	Search,
	WholeWord,
	X,
} from "../Icons";
import { SearchResultFileHeader } from "./SearchResultFileHeader";
import { SearchResultMatch } from "./SearchResultMatch";

/** Rows to render beyond the viewport on each side, to mask fast scrolling. */
const OVERSCAN = 8;

function ToggleButton({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className="w-5 h-5 rounded flex items-center justify-center transition-colors"
			style={{
				color: active ? "var(--accent)" : "var(--fg-secondary)",
				backgroundColor: active
					? "color-mix(in srgb, var(--accent) 15%, transparent)"
					: "transparent",
				transitionDuration: "var(--transition-fast)",
			}}
		>
			{children}
		</button>
	);
}

export function SearchPanel() {
	const inputRef = useRef<HTMLInputElement>(null);
	const workspace = useWorkspaceStore((s) => {
		const id = s.activeWorkspaceId;
		return id ? s.workspaces.find((w) => w.id === id) : null;
	});
	const rootPath = workspace?.rootFolder ?? null;
	const rightSidebarOpen = useWindowUiStore((s) => s.rightSidebarOpen);
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const isVisible = rightSidebarOpen && activeTab === "search";

	const query = useSearchStore((s) => s.query);
	const caseSensitive = useSearchStore((s) => s.caseSensitive);
	const isRegex = useSearchStore((s) => s.isRegex);
	const wholeWord = useSearchStore((s) => s.wholeWord);
	const includePattern = useSearchStore((s) => s.includePattern);
	const excludePattern = useSearchStore((s) => s.excludePattern);
	const showFilters = useSearchStore((s) => s.showFilters);
	const results = useSearchStore((s) => s.results);
	const totalMatches = useSearchStore((s) => s.totalMatches);
	const truncated = useSearchStore((s) => s.truncated);
	const loading = useSearchStore((s) => s.loading);
	const error = useSearchStore((s) => s.error);
	const collapsedFiles = useSearchStore((s) => s.collapsedFiles);
	const toggleFileCollapsed = useSearchStore((s) => s.toggleFileCollapsed);

	const setQuery = useSearchStore((s) => s.setQuery);
	const setCaseSensitive = useSearchStore((s) => s.setCaseSensitive);
	const setIsRegex = useSearchStore((s) => s.setIsRegex);
	const setWholeWord = useSearchStore((s) => s.setWholeWord);
	const setIncludePattern = useSearchStore((s) => s.setIncludePattern);
	const setExcludePattern = useSearchStore((s) => s.setExcludePattern);
	const toggleFilters = useSearchStore((s) => s.toggleFilters);
	const clear = useSearchStore((s) => s.clear);
	const cancelSearch = useSearchStore((s) => s.cancelSearch);
	const rescope = useSearchStore((s) => s.rescope);

	// Re-point the search at the active workspace whenever it changes (and on
	// mount, in case the workspace switched while this panel was closed). The
	// store no-ops when the root is unchanged, so toggling the panel keeps results.
	useEffect(() => {
		rescope(rootPath);
	}, [rootPath, rescope]);

	// Focus input when search tab becomes visible in the right sidebar.
	useEffect(() => {
		if (isVisible) {
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [isVisible]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				// Escalate: cancel an in-flight search first (keeping the results
				// found so far); only clear the query once nothing is running.
				if (loading) {
					cancelSearch();
				} else if (query) {
					clear();
				}
				e.stopPropagation();
			}
		},
		[loading, query, cancelSearch, clear],
	);

	// Stable handler: opens the file and jumps to the match line. Passing this
	// (rather than an inline closure) keeps the memoized match rows from
	// re-rendering when the panel does.
	const openMatch = useCallback((filePath: string, lineNumber: number) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId) return;
		useExplorerStore.getState().openFile(workspaceId, filePath);
		useExplorerStore
			.getState()
			.setPendingGotoLine({ filePath, line: lineNumber });
	}, []);

	// --- Virtualized result list ---------------------------------------------
	// The grouped results are flattened to a single fixed-height row list so we
	// can render only the slice intersecting the viewport. This keeps the DOM at
	// ~viewport-size regardless of how many thousands of matches exist.
	const scrollRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(0);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		setViewportHeight(el.clientHeight);
		const observer = new ResizeObserver(() => {
			setViewportHeight(el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const rows = useMemo(
		() => flattenSearchRows(results, collapsedFiles),
		[results, collapsedFiles],
	);

	const totalHeight = rows.length * SEARCH_ROW_HEIGHT;
	const startIndex = Math.max(
		0,
		Math.floor(scrollTop / SEARCH_ROW_HEIGHT) - OVERSCAN,
	);
	const endIndex = Math.min(
		rows.length,
		Math.ceil((scrollTop + viewportHeight) / SEARCH_ROW_HEIGHT) + OVERSCAN,
	);
	const visibleRows = rows.slice(startIndex, endIndex);
	const offsetY = startIndex * SEARCH_ROW_HEIGHT;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard handler for search panel
		<div
			className="flex flex-col h-full"
			style={{ fontSize: 12 }}
			onKeyDown={handleKeyDown}
		>
			{/* Search input area */}
			<div
				className="flex flex-col gap-1.5 flex-shrink-0"
				style={{ padding: "8px 12px" }}
			>
				{/* Query input */}
				<div
					className="flex items-center gap-1"
					style={{
						border: "1px solid var(--border)",
						borderRadius: 4,
						backgroundColor: "var(--bg-primary)",
						padding: "0 4px",
					}}
				>
					<span style={{ color: "var(--fg-secondary)", flexShrink: 0 }}>
						<Search size={12} />
					</span>
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value, rootPath)}
						placeholder="Search"
						className="bg-transparent outline-none flex-1 min-w-0"
						style={{
							color: "var(--fg-primary)",
							fontSize: 12,
							padding: "5px 4px",
							fontFamily: "var(--font-ui)",
						}}
					/>
					<ToggleButton
						active={caseSensitive}
						onClick={() => setCaseSensitive(!caseSensitive, rootPath)}
						title="Match Case"
					>
						<CaseSensitive size={12} />
					</ToggleButton>
					<ToggleButton
						active={wholeWord}
						onClick={() => setWholeWord(!wholeWord, rootPath)}
						title="Match Whole Word"
					>
						<WholeWord size={12} />
					</ToggleButton>
					<ToggleButton
						active={isRegex}
						onClick={() => setIsRegex(!isRegex, rootPath)}
						title="Use Regular Expression"
					>
						<Regex size={12} />
					</ToggleButton>
				</div>

				{/* Filter toggle + clear */}
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={toggleFilters}
						className="flex items-center gap-1 hover:bg-[var(--bg-tertiary)] rounded px-1 transition-colors"
						style={{
							color: "var(--fg-secondary)",
							fontSize: 11,
							transitionDuration: "var(--transition-fast)",
						}}
					>
						{showFilters ? (
							<ChevronDown size={10} />
						) : (
							<ChevronRight size={10} />
						)}
						<Ellipsis size={12} />
					</button>
					{query && (
						<button
							type="button"
							onClick={clear}
							className="flex items-center justify-center hover:bg-[var(--bg-tertiary)] rounded w-5 h-5 transition-colors"
							style={{
								color: "var(--fg-secondary)",
								transitionDuration: "var(--transition-fast)",
							}}
							title="Clear search"
						>
							<X size={12} />
						</button>
					)}
				</div>

				{/* File filter inputs */}
				{showFilters && (
					<div className="flex flex-col gap-1">
						<input
							type="text"
							value={includePattern}
							onChange={(e) => setIncludePattern(e.target.value, rootPath)}
							placeholder="files to include (e.g. *.ts, src/**)"
							className="bg-transparent outline-none"
							style={{
								color: "var(--fg-primary)",
								fontSize: 11,
								padding: "4px 8px",
								border: "1px solid var(--border)",
								borderRadius: 4,
								backgroundColor: "var(--bg-primary)",
								fontFamily: "var(--font-ui)",
							}}
						/>
						<input
							type="text"
							value={excludePattern}
							onChange={(e) => setExcludePattern(e.target.value, rootPath)}
							placeholder="files to exclude (e.g. node_modules, dist)"
							className="bg-transparent outline-none"
							style={{
								color: "var(--fg-primary)",
								fontSize: 11,
								padding: "4px 8px",
								border: "1px solid var(--border)",
								borderRadius: 4,
								backgroundColor: "var(--bg-primary)",
								fontFamily: "var(--font-ui)",
							}}
						/>
					</div>
				)}
			</div>

			{/* Status bar — pinned above the scroll area so it stays visible while
			 *  scrolling thousands of results. */}
			<div className="flex-shrink-0">
				{/* Loading indicator — stays visible for the whole walk, alongside any
				 *  results already streamed in, and advertises Esc-to-cancel. */}
				{loading && (
					<div
						className="shimmer-text"
						style={{ padding: "8px 12px", fontSize: 11 }}
					>
						Searching... (Esc to cancel)
					</div>
				)}

				{/* Error message */}
				{error && (
					<div
						style={{
							padding: "8px 12px",
							color: "var(--error)",
							fontSize: 11,
							wordBreak: "break-word",
						}}
					>
						{error}
					</div>
				)}

				{/* Result count — updates live as matches stream in. */}
				{!error && totalMatches > 0 && (
					<div
						style={{
							padding: "4px 12px",
							color: "var(--fg-secondary)",
							fontSize: 11,
						}}
					>
						{totalMatches.toLocaleString()} result
						{totalMatches !== 1 ? "s" : ""} in {results.length.toLocaleString()}{" "}
						file
						{results.length !== 1 ? "s" : ""}
						{truncated && " (result limit reached)"}
					</div>
				)}

				{/* No results */}
				{!loading && !error && query.trim() && totalMatches === 0 && (
					<div
						style={{
							padding: "8px 12px",
							color: "var(--fg-secondary)",
							fontSize: 11,
						}}
					>
						No results found.
					</div>
				)}
			</div>

			{/* Virtualized result list — only the rows intersecting the viewport
			 *  are mounted, so DOM size stays constant as results grow. */}
			<div
				ref={scrollRef}
				onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
				className="flex-1 min-h-0 overflow-y-auto"
			>
				{rootPath && rows.length > 0 && (
					<div style={{ height: totalHeight, position: "relative" }}>
						<div
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								right: 0,
								transform: `translateY(${offsetY}px)`,
							}}
						>
							{visibleRows.map((row) =>
								row.kind === "file" ? (
									<SearchResultFileHeader
										key={row.key}
										file={row.file}
										rootPath={rootPath}
										collapsed={!!collapsedFiles[row.file.filePath]}
										onToggle={toggleFileCollapsed}
									/>
								) : (
									<SearchResultMatch
										key={row.key}
										match={row.match}
										filePath={row.filePath}
										onOpen={openMatch}
									/>
								),
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

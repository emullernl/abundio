import { useCallback, useEffect, useRef } from "react";
import { useSearchStore } from "../../stores/searchStore";
import { useSettingsStore } from "../../stores/settingsStore";
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
import { SearchResultFile } from "./SearchResultFile";

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
	const sidebarBottomPanel = useSettingsStore((s) => s.sidebarBottomPanel);

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

	const setQuery = useSearchStore((s) => s.setQuery);
	const setCaseSensitive = useSearchStore((s) => s.setCaseSensitive);
	const setIsRegex = useSearchStore((s) => s.setIsRegex);
	const setWholeWord = useSearchStore((s) => s.setWholeWord);
	const setIncludePattern = useSearchStore((s) => s.setIncludePattern);
	const setExcludePattern = useSearchStore((s) => s.setExcludePattern);
	const toggleFilters = useSearchStore((s) => s.toggleFilters);
	const clear = useSearchStore((s) => s.clear);

	// Focus input when search panel becomes visible
	useEffect(() => {
		if (sidebarBottomPanel === "search") {
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [sidebarBottomPanel]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				if (query) {
					clear();
				}
				e.stopPropagation();
			}
		},
		[query, clear],
	);

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

			{/* Results area */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{/* Loading indicator */}
				{loading && (
					<div
						style={{
							padding: "8px 12px",
							color: "var(--fg-secondary)",
							fontSize: 11,
						}}
					>
						Searching...
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

				{/* Result count */}
				{!loading && !error && totalMatches > 0 && (
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

				{/* File results */}
				{!loading &&
					rootPath &&
					results.map((fileResult) => (
						<SearchResultFile
							key={fileResult.filePath}
							fileResult={fileResult}
							rootPath={rootPath}
						/>
					))}
			</div>
		</div>
	);
}

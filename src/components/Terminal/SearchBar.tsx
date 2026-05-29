import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Props {
	searchAddon: SearchAddon;
	onClose: () => void;
}

function readCssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
}

export function SearchBar({ searchAddon, onClose }: Props) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	// Without `decorations`, xterm's SearchAddon only paints the active match
	// using the terminal's `selectionBackground` (the same muted color used for
	// normal text selection) and leaves every other match unmarked. Pulling
	// theme colors via CSS vars gives us a bright active highlight (warning bg
	// + accent border) and a distinct fill for all other matches, so they're
	// visible at a glance regardless of which theme is active.
	const searchOptions = useMemo<ISearchOptions>(() => {
		const accent = readCssVar("--accent", "#58D5BA");
		const warning = readCssVar("--warning", "#D29922");
		return {
			caseSensitive: false,
			regex: false,
			decorations: {
				matchBackground: accent,
				matchOverviewRuler: accent,
				activeMatchBackground: warning,
				activeMatchBorder: accent,
				activeMatchColorOverviewRuler: warning,
			},
		};
	}, []);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (query) {
			searchAddon.findNext(query, searchOptions);
		}
	}, [query, searchAddon, searchOptions]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				searchAddon.clearDecorations();
				onClose();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (e.shiftKey) {
					searchAddon.findPrevious(query, searchOptions);
				} else {
					searchAddon.findNext(query, searchOptions);
				}
			}
		},
		[query, searchAddon, searchOptions, onClose],
	);

	return (
		<div
			className="absolute top-2 right-2 z-10 flex items-center gap-2 rounded-lg shadow-lg"
			style={{
				backgroundColor: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				padding: "6px 10px",
			}}
		>
			<input
				ref={inputRef}
				type="text"
				placeholder="Search..."
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				className="bg-transparent outline-none"
				style={{ color: "var(--fg-primary)", fontSize: 13, width: 200 }}
			/>
			<button
				type="button"
				onClick={() => searchAddon.findPrevious(query, searchOptions)}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9650;
			</button>
			<button
				type="button"
				onClick={() => searchAddon.findNext(query, searchOptions)}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9660;
			</button>
			<button
				type="button"
				onClick={() => {
					searchAddon.clearDecorations();
					onClose();
				}}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&times;
			</button>
		</div>
	);
}

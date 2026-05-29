import { memo } from "react";
import { SEARCH_ROW_HEIGHT } from "../../lib/searchRows";
import type { SearchMatch } from "../../lib/types";

interface SearchResultMatchProps {
	match: SearchMatch;
	filePath: string;
	/** Stable handler so the memoized row only re-renders when `match` changes. */
	onOpen: (filePath: string, lineNumber: number) => void;
}

export const SearchResultMatch = memo(function SearchResultMatch({
	match,
	filePath,
	onOpen,
}: SearchResultMatchProps) {
	const before = match.lineContent.slice(0, match.matchStart);
	const matched = match.lineContent.slice(match.matchStart, match.matchEnd);
	const after = match.lineContent.slice(match.matchEnd);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: search result item
		// biome-ignore lint/a11y/noStaticElementInteractions: clickable search result
		<div
			onClick={() => onOpen(filePath, match.lineNumber)}
			className="flex items-center gap-2 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
			style={{
				height: SEARCH_ROW_HEIGHT,
				padding: "0 8px 0 28px",
				fontSize: 12,
				transitionDuration: "var(--transition-fast)",
			}}
		>
			<span
				className="flex-shrink-0"
				style={{
					color: "var(--fg-secondary)",
					minWidth: 32,
					textAlign: "right",
					userSelect: "none",
				}}
			>
				{match.lineNumber}
			</span>
			<span
				className="truncate min-w-0"
				style={{
					color: "var(--fg-primary)",
					fontFamily: "var(--font-mono)",
				}}
			>
				{before}
				<span
					style={{
						backgroundColor:
							"color-mix(in srgb, var(--accent) 25%, transparent)",
						borderRadius: 2,
					}}
				>
					{matched}
				</span>
				{after}
			</span>
		</div>
	);
});

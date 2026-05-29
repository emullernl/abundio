import { memo } from "react";
import { SEARCH_ROW_HEIGHT } from "../../lib/searchRows";
import type { SearchFileResult } from "../../lib/types";
import { ChevronDown, ChevronRight, File } from "../Icons";

interface SearchResultFileHeaderProps {
	file: SearchFileResult;
	rootPath: string;
	collapsed: boolean;
	/** Stable handler so the memoized row only re-renders when its data changes. */
	onToggle: (filePath: string) => void;
}

export const SearchResultFileHeader = memo(function SearchResultFileHeader({
	file,
	rootPath,
	collapsed,
	onToggle,
}: SearchResultFileHeaderProps) {
	const relativePath = file.filePath.startsWith(rootPath)
		? file.filePath.slice(rootPath.length + 1)
		: file.filePath;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: collapsible file group header
		// biome-ignore lint/a11y/noStaticElementInteractions: clickable file group
		<div
			onClick={() => onToggle(file.filePath)}
			className="flex items-center gap-1 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
			style={{
				height: SEARCH_ROW_HEIGHT,
				padding: "0 8px",
				fontSize: 12,
				transitionDuration: "var(--transition-fast)",
			}}
		>
			<span style={{ color: "var(--fg-secondary)" }}>
				{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
			</span>
			<span style={{ color: "var(--fg-secondary)" }}>
				<File size={12} />
			</span>
			<span
				className="truncate min-w-0"
				style={{ color: "var(--fg-primary)" }}
				title={relativePath}
			>
				{relativePath}
			</span>
			<span
				className="flex-shrink-0 rounded-full"
				style={{
					color: "var(--fg-secondary)",
					fontSize: 10,
					backgroundColor:
						"color-mix(in srgb, var(--fg-secondary) 20%, transparent)",
					padding: "0 5px",
					marginLeft: "auto",
				}}
			>
				{file.matches.length}
			</span>
		</div>
	);
});

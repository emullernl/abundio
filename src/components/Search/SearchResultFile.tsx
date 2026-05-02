import type { SearchFileResult } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSearchStore } from "../../stores/searchStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { ChevronDown, ChevronRight, File } from "../Icons";
import { SearchResultMatch } from "./SearchResultMatch";

interface SearchResultFileProps {
	fileResult: SearchFileResult;
	rootPath: string;
}

export function SearchResultFile({
	fileResult,
	rootPath,
}: SearchResultFileProps) {
	const collapsed = useSearchStore(
		(s) => s.collapsedFiles[fileResult.filePath],
	);
	const toggleCollapsed = useSearchStore((s) => s.toggleFileCollapsed);

	const relativePath = fileResult.filePath.startsWith(rootPath)
		? fileResult.filePath.slice(rootPath.length + 1)
		: fileResult.filePath;

	const handleResultClick = (lineNumber: number) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId) return;
		useExplorerStore.getState().openFile(workspaceId, fileResult.filePath);
		useExplorerStore
			.getState()
			.setPendingGotoLine({ filePath: fileResult.filePath, line: lineNumber });
	};

	return (
		<div>
			{/* File header */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: collapsible file group header */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable file group */}
			<div
				onClick={() => toggleCollapsed(fileResult.filePath)}
				className="flex items-center gap-1 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
				style={{
					padding: "3px 8px",
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
					{fileResult.matches.length}
				</span>
			</div>

			{/* Matches */}
			{!collapsed && (
				<div>
					{fileResult.matches.map((match) => (
						<SearchResultMatch
							key={`${match.lineNumber}-${match.matchStart}-${match.matchEnd}`}
							match={match}
							rootPath={rootPath}
							onClick={() => handleResultClick(match.lineNumber)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

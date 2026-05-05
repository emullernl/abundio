import { useState } from "react";
import type { DirEntry } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { ChevronDown, ChevronRight, File, FolderOpen, Image } from "../Icons";
import { EditingRow } from "./EditingRow";

interface FileTreeItemProps {
	entry: DirEntry;
	depth: number;
	isExpanded: boolean;
	onToggleDir: (path: string) => void;
	onOpenFile: (filePath: string) => void;
	onContextMenu: (x: number, y: number, entry: DirEntry) => void;
	pendingRename: boolean;
	children?: React.ReactNode;
}

function getFileColor(ext: string | null): string {
	if (!ext) return "var(--fg-secondary)";
	switch (ext) {
		case "ts":
		case "tsx":
			return "#3178c6";
		case "js":
		case "jsx":
		case "mjs":
			return "#f7df1e";
		case "json":
			return "#a8b1c2";
		case "md":
		case "mdx":
			return "#519aba";
		case "css":
		case "scss":
		case "less":
			return "#563d7c";
		case "html":
		case "htm":
			return "#e34c26";
		case "py":
			return "#3572a5";
		case "rs":
			return "#dea584";
		case "go":
			return "#00add8";
		case "java":
			return "#b07219";
		case "c":
		case "cpp":
		case "h":
		case "hpp":
			return "#555555";
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "webp":
		case "svg":
		case "ico":
			return "#a074c4";
		default:
			return "var(--fg-secondary)";
	}
}

export function FileTreeItem({
	entry,
	depth,
	isExpanded,
	onToggleDir,
	onOpenFile,
	onContextMenu,
	pendingRename,
	children,
}: FileTreeItemProps) {
	const [hovered, setHovered] = useState(false);
	const commitEdit = useExplorerStore((s) => s.commitEdit);
	const cancelEdit = useExplorerStore((s) => s.cancelEdit);
	const isImage =
		entry.extension &&
		["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(
			entry.extension,
		);

	const handleClick = () => {
		if (entry.isDir) {
			onToggleDir(entry.path);
		} else {
			onOpenFile(entry.path);
		}
	};

	const Icon = entry.isDir
		? isExpanded
			? FolderOpen
			: FolderOpen
		: isImage
			? Image
			: File;

	const iconColor = entry.isDir
		? "var(--accent)"
		: getFileColor(entry.extension);

	if (pendingRename) {
		return (
			<>
				<EditingRow
					depth={depth}
					mode={entry.isDir ? "folder" : "file"}
					initialValue={entry.name}
					onCommit={commitEdit}
					onCancel={cancelEdit}
				/>
				{entry.isDir && isExpanded && children}
			</>
		);
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				onMouseDown={(e) => {
					if (e.button === 2) e.preventDefault();
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onContextMenu(e.clientX, e.clientY, entry);
				}}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				className="w-full flex items-center gap-1 text-left rounded-sm"
				style={{
					paddingLeft: 8 + depth * 12,
					paddingRight: 8,
					height: 24,
					fontSize: 12,
					color: "var(--fg-primary)",
					backgroundColor: hovered ? "var(--bg-tertiary)" : "transparent",
					transition: "background-color 80ms ease-out",
					userSelect: "none",
				}}
			>
				{entry.isDir ? (
					<span
						style={{ width: 14, flexShrink: 0, color: "var(--fg-secondary)" }}
					>
						{isExpanded ? (
							<ChevronDown size={12} />
						) : (
							<ChevronRight size={12} />
						)}
					</span>
				) : (
					<span style={{ width: 14, flexShrink: 0 }} />
				)}
				<span style={{ color: iconColor, flexShrink: 0, display: "flex" }}>
					<Icon size={14} />
				</span>
				<span className="truncate">{entry.name}</span>
			</button>
			{entry.isDir && isExpanded && children}
		</>
	);
}

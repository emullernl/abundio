import { useEffect } from "react";
import { fs as fsApi } from "../../lib/ipc";
import type { DirEntry } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { FileTreeItem } from "./FileTreeItem";

interface FileTreeProps {
	rootPath: string;
	workspaceId: string;
}

function TreeLevel({
	dirPath,
	workspaceId,
	depth,
}: {
	dirPath: string;
	workspaceId: string;
	depth: number;
}) {
	const entries = useExplorerStore((s) => s.dirContents[dirPath]);
	const expandedDirs = useExplorerStore((s) => s.expandedDirs);
	const toggleDir = useExplorerStore((s) => s.toggleDir);
	const openFile = useExplorerStore((s) => s.openFile);

	if (!entries) return null;

	return (
		<>
			{entries.map((entry: DirEntry) => (
				<FileTreeItem
					key={entry.path}
					entry={entry}
					depth={depth}
					isExpanded={!!expandedDirs[entry.path]}
					onToggleDir={toggleDir}
					onOpenFile={(filePath) => openFile(workspaceId, filePath)}
				>
					{entry.isDir && expandedDirs[entry.path] && (
						<TreeLevel
							dirPath={entry.path}
							workspaceId={workspaceId}
							depth={depth + 1}
						/>
					)}
				</FileTreeItem>
			))}
		</>
	);
}

export function FileTree({ rootPath, workspaceId }: FileTreeProps) {
	const loadDir = useExplorerStore((s) => s.loadDir);
	const entries = useExplorerStore((s) => s.dirContents[rootPath]);

	useEffect(() => {
		if (!entries) {
			loadDir(rootPath);
		}
	}, [rootPath, entries, loadDir]);

	// Dir-refresh listener. The Rust watcher itself is owned by
	// useFileReloadWatcher so it survives workspace switches.
	useEffect(() => {
		let unlisten: (() => void) | null = null;
		let cancelled = false;
		fsApi
			.onFsChange(rootPath, ({ paths }) => {
				useExplorerStore.getState().refreshDirs(paths);
			})
			.then((fn) => {
				if (cancelled) fn();
				else unlisten = fn;
			})
			.catch((err) => {
				console.error("[FileTree] onFsChange listen failed:", err);
			});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [rootPath]);

	if (!entries) {
		return (
			<div
				className="px-4 py-2"
				style={{ fontSize: 12, color: "var(--fg-secondary)" }}
			>
				Loading...
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div
				className="px-4 py-2"
				style={{ fontSize: 12, color: "var(--fg-secondary)" }}
			>
				Empty folder
			</div>
		);
	}

	return (
		<div className="py-1">
			<TreeLevel dirPath={rootPath} workspaceId={workspaceId} depth={0} />
		</div>
	);
}

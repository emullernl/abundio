import { useEffect } from "react";
import { fs as fsApi } from "../../lib/ipc";
import type { DirEntry } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { FileTreeItem } from "./FileTreeItem";

interface FileTreeProps {
	rootPath: string;
	sessionId: string;
}

function TreeLevel({
	dirPath,
	sessionId,
	depth,
}: {
	dirPath: string;
	sessionId: string;
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
					onOpenFile={(filePath) => openFile(sessionId, filePath)}
				>
					{entry.isDir && expandedDirs[entry.path] && (
						<TreeLevel
							dirPath={entry.path}
							sessionId={sessionId}
							depth={depth + 1}
						/>
					)}
				</FileTreeItem>
			))}
		</>
	);
}

export function FileTree({ rootPath, sessionId }: FileTreeProps) {
	const loadDir = useExplorerStore((s) => s.loadDir);
	const entries = useExplorerStore((s) => s.dirContents[rootPath]);

	useEffect(() => {
		if (!entries) {
			loadDir(rootPath);
		}
	}, [rootPath, entries, loadDir]);

	// File system watcher: start on mount, stop on unmount
	useEffect(() => {
		fsApi.watchStart(rootPath).catch((err) => {
			console.error("[FileTree] fs_watch_start failed:", err);
		});

		let unlisten: (() => void) | null = null;
		fsApi
			.onFsChange(rootPath, (paths) => {
				useExplorerStore.getState().refreshDirs(paths);
			})
			.then((fn) => {
				unlisten = fn;
			})
			.catch((err) => {
				console.error("[FileTree] onFsChange listen failed:", err);
			});

		return () => {
			fsApi.watchStop(rootPath);
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
			<TreeLevel dirPath={rootPath} sessionId={sessionId} depth={0} />
		</div>
	);
}

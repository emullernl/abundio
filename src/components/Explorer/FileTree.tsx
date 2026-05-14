import { useEffect, useState } from "react";
import { fs as fsApi } from "../../lib/ipc";
import type { DirEntry } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { ConfirmDialog } from "../ConfirmDialog";
import type { ContextMenuItem } from "../Terminal/PaneContextMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";
import { EditingRow } from "./EditingRow";
import { FileTreeItem } from "./FileTreeItem";

interface FileTreeProps {
	rootPath: string;
	workspaceId: string;
}

const REVEAL_LABEL = navigator.platform.toLowerCase().includes("mac")
	? "Reveal in Finder"
	: navigator.platform.toLowerCase().includes("win")
		? "Reveal in Explorer"
		: "Reveal in File Manager";

function dirname(p: string): string {
	return p.substring(0, p.lastIndexOf("/"));
}

function TreeLevel({
	dirPath,
	workspaceId,
	depth,
	onContextMenu,
}: {
	dirPath: string;
	workspaceId: string;
	depth: number;
	onContextMenu: (x: number, y: number, entry: DirEntry) => void;
}) {
	const entries = useExplorerStore((s) => s.dirContents[dirPath]);
	const expandedDirs = useExplorerStore((s) => s.expandedDirs);
	const toggleDir = useExplorerStore((s) => s.toggleDir);
	const openFile = useExplorerStore((s) => s.openFile);
	const pendingEdit = useExplorerStore((s) => s.pendingEdit);
	const commitEdit = useExplorerStore((s) => s.commitEdit);
	const cancelEdit = useExplorerStore((s) => s.cancelEdit);

	if (!entries) return null;

	const showCreateRow =
		pendingEdit?.kind === "create" && pendingEdit.parentDir === dirPath;

	return (
		<>
			{showCreateRow && pendingEdit?.kind === "create" && (
				<EditingRow
					depth={depth}
					mode={pendingEdit.type}
					onCommit={commitEdit}
					onCancel={cancelEdit}
				/>
			)}
			{entries.map((entry: DirEntry) => {
				const isPendingRename =
					pendingEdit?.kind === "rename" &&
					pendingEdit.targetPath === entry.path;

				return (
					<FileTreeItem
						key={entry.path}
						entry={entry}
						depth={depth}
						isExpanded={!!expandedDirs[entry.path]}
						onToggleDir={toggleDir}
						onOpenFile={(filePath) => openFile(workspaceId, filePath)}
						onContextMenu={onContextMenu}
						pendingRename={isPendingRename}
					>
						{entry.isDir && expandedDirs[entry.path] && (
							<TreeLevel
								dirPath={entry.path}
								workspaceId={workspaceId}
								depth={depth + 1}
								onContextMenu={onContextMenu}
							/>
						)}
					</FileTreeItem>
				);
			})}
		</>
	);
}

export function FileTree({ rootPath, workspaceId }: FileTreeProps) {
	const loadDir = useExplorerStore((s) => s.loadDir);
	const entries = useExplorerStore((s) => s.dirContents[rootPath]);
	const startCreate = useExplorerStore((s) => s.startCreate);
	const startRename = useExplorerStore((s) => s.startRename);
	const pendingEdit = useExplorerStore((s) => s.pendingEdit);

	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		entry: DirEntry | null;
	} | null>(null);
	const [pendingDelete, setPendingDelete] = useState<{
		path: string;
		name: string;
		isDir: boolean;
	} | null>(null);

	const refreshDirs = useExplorerStore((s) => s.refreshDirs);

	useEffect(() => {
		if (!entries) {
			loadDir(rootPath);
		}
	}, [rootPath, entries, loadDir]);

	const handleContextMenu = (x: number, y: number, entry: DirEntry) => {
		setMenu({ x, y, entry });
	};

	const buildMenuItems = (): ContextMenuItem[] => {
		if (!menu) return [];
		const { entry } = menu;

		if (entry === null) {
			// Empty-area menu — scoped to workspace root
			return [
				{
					label: "New File…",
					onClick: () => {
						setMenu(null);
						startCreate(rootPath, "file");
					},
				},
				{
					label: "New Folder…",
					onClick: () => {
						setMenu(null);
						startCreate(rootPath, "folder");
					},
				},
				{ separator: true as const },
				{
					label: REVEAL_LABEL.replace("in ", "Folder in "),
					onClick: () => {
						setMenu(null);
						fsApi.revealInFolder(rootPath).catch(console.error);
					},
				},
			];
		}

		if (entry.isDir) {
			return [
				{
					label: "New File…",
					onClick: () => {
						setMenu(null);
						startCreate(entry.path, "file");
					},
				},
				{
					label: "New Folder…",
					onClick: () => {
						setMenu(null);
						startCreate(entry.path, "folder");
					},
				},
				{ separator: true as const },
				{
					label: REVEAL_LABEL,
					onClick: () => {
						setMenu(null);
						fsApi.revealInFolder(entry.path).catch(console.error);
					},
				},
				{ separator: true as const },
				{
					label: "Rename",
					onClick: () => {
						setMenu(null);
						startRename(entry.path, true);
					},
				},
				{
					label: "Delete",
					onClick: () => {
						setMenu(null);
						setPendingDelete({
							path: entry.path,
							name: entry.name,
							isDir: true,
						});
					},
				},
			];
		}

		// File entry
		const openFile = useExplorerStore.getState().openFile;
		const openFileInSplit = useExplorerStore.getState().openFileInSplit;
		return [
			{
				label: "Open in New Tab",
				onClick: () => {
					setMenu(null);
					openFile(workspaceId, entry.path);
				},
			},
			{
				label: "Open Beside",
				onClick: () => {
					setMenu(null);
					openFileInSplit(workspaceId, entry.path, "vertical");
				},
			},
			{
				label: "Open Below",
				onClick: () => {
					setMenu(null);
					openFileInSplit(workspaceId, entry.path, "horizontal");
				},
			},
			{ separator: true as const },
			{
				label: REVEAL_LABEL,
				onClick: () => {
					setMenu(null);
					fsApi.revealInFolder(entry.path).catch(console.error);
				},
			},
			{ separator: true as const },
			{
				label: "Rename",
				onClick: () => {
					setMenu(null);
					startRename(entry.path, false);
				},
			},
			{
				label: "Delete",
				onClick: () => {
					setMenu(null);
					setPendingDelete({
						path: entry.path,
						name: entry.name,
						isDir: false,
					});
				},
			},
		];
	};

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

	if (entries.length === 0 && !pendingEdit) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: context menu on container — buttons inside are keyboard-accessible
			<div
				className="min-h-full"
				onContextMenu={(e) => {
					if ((e.target as HTMLElement).closest("button")) return;
					e.preventDefault();
					setMenu({ x: e.clientX, y: e.clientY, entry: null });
				}}
			>
				<div
					className="px-4 py-2"
					style={{ fontSize: 12, color: "var(--fg-secondary)" }}
				>
					Empty folder
				</div>
				{menu && (
					<PaneContextMenu
						x={menu.x}
						y={menu.y}
						items={buildMenuItems()}
						onClose={() => setMenu(null)}
					/>
				)}
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: context menu on container — buttons inside are keyboard-accessible
		<div
			className="py-1 min-h-full select-none"
			onContextMenu={(e) => {
				if ((e.target as HTMLElement).closest("button")) return;
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY, entry: null });
			}}
		>
			<TreeLevel
				dirPath={rootPath}
				workspaceId={workspaceId}
				depth={0}
				onContextMenu={handleContextMenu}
			/>

			{menu && (
				<PaneContextMenu
					x={menu.x}
					y={menu.y}
					items={buildMenuItems()}
					onClose={() => setMenu(null)}
				/>
			)}

			{pendingDelete && (
				<ConfirmDialog
					title={pendingDelete.isDir ? "Delete folder?" : "Delete file?"}
					message={
						pendingDelete.isDir
							? `"${pendingDelete.name}" and all of its contents will be permanently deleted. This cannot be undone.`
							: `"${pendingDelete.name}" will be permanently deleted. This cannot be undone.`
					}
					confirmLabel="Delete"
					confirmVariant="danger"
					onConfirm={async () => {
						await fsApi.deletePath(pendingDelete.path).catch(console.error);
						refreshDirs([dirname(pendingDelete.path)]);
						setPendingDelete(null);
					}}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
		</div>
	);
}

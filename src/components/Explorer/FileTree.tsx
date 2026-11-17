import { useEffect, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import { copyPathEntries } from "../../lib/copyPathEntries";
import { fileTreeMenu } from "../../lib/fileTreeMenu";
import { fileWindowKindFor } from "../../lib/fileWindowKind";
import { fs as fsApi } from "../../lib/ipc";
import {
	clickOpensFileWindow,
	openFileWindowForPath,
} from "../../lib/openFileWindow";
import { revealLabel } from "../../lib/platform";
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
	/** Only open, reveal and copy paths: no create, rename or delete (the
	 *  **Peek explorer**). */
	readOnly?: boolean;
	/** Where a plain click on a file opens it. The Explorer's own Tab by
	 *  default; Cmd/Ctrl+click still opens a File window. */
	onOpenFile?: (filePath: string) => void;
}

const REVEAL_LABEL = revealLabel();

function dirname(p: string): string {
	return p.substring(0, p.lastIndexOf("/"));
}

function TreeLevel({
	dirPath,
	workspaceId,
	depth,
	onContextMenu,
	openPath,
	readOnly,
}: {
	dirPath: string;
	workspaceId: string;
	depth: number;
	onContextMenu: (x: number, y: number, entry: DirEntry) => void;
	openPath: (filePath: string) => void;
	readOnly: boolean;
}) {
	const entries = useExplorerStore((s) => s.dirContents[dirPath]);
	const expandedDirs = useExplorerStore((s) => s.expandedDirs);
	const toggleDir = useExplorerStore((s) => s.toggleDir);
	const storeEdit = useExplorerStore((s) => s.pendingEdit);
	// A read-only tree never shows the inline create / rename rows.
	const pendingEdit = readOnly ? null : storeEdit;
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
						onOpenFile={(filePath, modifiers) =>
							clickOpensFileWindow(modifiers, filePath)
								? openFileWindowForPath(workspaceId, filePath)
								: openPath(filePath)
						}
						onContextMenu={onContextMenu}
						pendingRename={isPendingRename}
					>
						{entry.isDir && expandedDirs[entry.path] && (
							<TreeLevel
								dirPath={entry.path}
								workspaceId={workspaceId}
								depth={depth + 1}
								onContextMenu={onContextMenu}
								openPath={openPath}
								readOnly={readOnly}
							/>
						)}
					</FileTreeItem>
				);
			})}
		</>
	);
}

export function FileTree({
	rootPath,
	workspaceId,
	readOnly = false,
	onOpenFile,
}: FileTreeProps) {
	const loadDir = useExplorerStore((s) => s.loadDir);
	const entries = useExplorerStore((s) => s.dirContents[rootPath]);
	const startCreate = useExplorerStore((s) => s.startCreate);
	const startRename = useExplorerStore((s) => s.startRename);
	const openFileAsDiff = useExplorerStore((s) => s.openFileAsDiff);
	const storeEdit = useExplorerStore((s) => s.pendingEdit);
	const pendingEdit = readOnly ? null : storeEdit;
	const openPath = (filePath: string) => {
		if (onOpenFile) onOpenFile(filePath);
		else void useExplorerStore.getState().openFile(workspaceId, filePath);
	};

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

	/** See `copyPathEntries` — an entry with no relative form (outside the
	 *  workspace root) is disabled rather than dropped. */
	const copyPathItems = (absolutePath: string): ContextMenuItem[] =>
		copyPathEntries(rootPath, absolutePath).map((entry) => ({
			label: entry.label,
			disabled: entry.text === null,
			onClick: () => {
				setMenu(null);
				if (entry.text !== null) {
					writeClipboardText(entry.text).catch(console.error);
				}
			},
		}));

	const buildMenuItems = (): ContextMenuItem[] => {
		if (!menu) return [];
		const { entry } = menu;
		const target = entry?.path ?? rootPath;
		const store = useExplorerStore.getState();
		const act = (run: () => void) => () => {
			setMenu(null);
			run();
		};
		const ids = fileTreeMenu({
			entry,
			hasFileWindow: !!entry && !entry.isDir && !!fileWindowKindFor(entry.name),
			readOnly,
		});
		return ids.flatMap((id): ContextMenuItem[] => {
			switch (id) {
				case "separator":
					return [{ separator: true as const }];
				case "new-file":
					return [
						{
							label: "New File…",
							onClick: act(() => startCreate(target, "file")),
						},
					];
				case "new-folder":
					return [
						{
							label: "New Folder…",
							onClick: act(() => startCreate(target, "folder")),
						},
					];
				case "reveal":
				case "reveal-folder":
					return [
						{
							label:
								id === "reveal"
									? REVEAL_LABEL
									: REVEAL_LABEL.replace("in ", "Folder in "),
							onClick: act(() => {
								fsApi.revealInFolder(target).catch(console.error);
							}),
						},
					];
				case "copy-path":
					return copyPathItems(target);
				case "rename":
					return [
						{
							label: "Rename",
							onClick: act(() => startRename(target, !!entry?.isDir)),
						},
					];
				case "delete":
					return entry
						? [
								{
									label: "Delete",
									onClick: act(() =>
										setPendingDelete({
											path: entry.path,
											name: entry.name,
											isDir: entry.isDir,
										}),
									),
								},
							]
						: [];
				case "open":
					return [{ label: "Open", onClick: act(() => openPath(target)) }];
				case "open-tab":
					return [
						{
							label: "Open in New Tab",
							onClick: act(() => store.openFile(workspaceId, target)),
						},
					];
				case "open-beside":
					return [
						{
							label: "Open Beside",
							onClick: act(() =>
								store.openFileInSplit(workspaceId, target, "vertical"),
							),
						},
					];
				case "open-below":
					return [
						{
							label: "Open Below",
							onClick: act(() =>
								store.openFileInSplit(workspaceId, target, "horizontal"),
							),
						},
					];
				case "open-window":
					return [
						{
							label: "Open in Separate Window",
							onClick: act(() => {
								void openFileWindowForPath(workspaceId, target);
							}),
						},
					];
				case "open-diff":
					return [
						{
							label: "Open in Diff Viewer",
							onClick: act(() => {
								void openFileAsDiff(workspaceId, target).catch(console.error);
							}),
						},
					];
				default:
					return [];
			}
		});
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
				openPath={openPath}
				readOnly={readOnly}
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

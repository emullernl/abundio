import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveLayout } from "../../hooks/useActiveLayout";
import { useSplitPane } from "../../hooks/useSplitPane";
import {
	parseConflicts,
	type ResolveChoice,
	resolveAll,
} from "../../lib/conflictMarkers";
import { useDragPaneStore } from "../../lib/dragPaneStore";
import { git } from "../../lib/ipc";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { toggleMarkdownPreviewForPane } from "../../lib/markdownPreview";
import { requestPreviewPrint } from "../../lib/markdownPreviewPrint";
import {
	clearActiveConflictBlock,
	setActiveConflictBlock,
} from "../../lib/mergeSync";
import {
	hasMergeView,
	toggleMergeBase,
	toggleMergeViewForPane,
} from "../../lib/mergeView";
import { findPreviewForSource } from "../../lib/paneTree";
import { sc } from "../../lib/platform";
import {
	relativeToWorkspace,
	resolveWorkspacePath,
} from "../../lib/resolveWorkspacePath";
import type { GitChangedFile } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { DiffViewer } from "../GitChanges/DiffViewer";
import { PaneDropIndicator } from "../PaneDropIndicator";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";
import { CodeEditor, focusEditor, triggerEditorAction } from "./CodeEditor";
import { ConflictToolbar } from "./ConflictToolbar";
import { FileChangeBanner } from "./FileChangeBanner";
import { FilePaneTitleBar } from "./FilePaneTitleBar";
import { ImageViewer } from "./ImageViewer";
import { UnsupportedFile } from "./UnsupportedFile";

interface FilePaneProps {
	paneId: string;
	filePath: string;
	cwd: string;
	workspaceId: string;
	isDiff?: boolean;
	diffSection?: GitChangedFile["section"];
	isDeleted?: boolean;
	isFocused: boolean;
	onFocus: () => void;
}

export function FilePane({
	paneId,
	filePath,
	cwd,
	workspaceId,
	isDiff,
	diffSection,
	isDeleted,
	isFocused,
	onFocus,
}: FilePaneProps) {
	const registerFilePane = useExplorerStore((s) => s.registerFilePane);
	const unregisterFilePane = useExplorerStore((s) => s.unregisterFilePane);
	const paneState = useExplorerStore((s) => s.filePanes[paneId]);
	const updateFileContent = useExplorerStore((s) => s.updateFileContent);
	const reloadPaneFromDisk = useExplorerStore((s) => s.reloadPaneFromDisk);
	const dismissExternalChange = useExplorerStore(
		(s) => s.dismissExternalChange,
	);
	const saveFile = useExplorerStore((s) => s.saveFile);

	const handleEditorChange = useCallback(
		(content: string) => updateFileContent(paneId, content),
		[paneId, updateFileContent],
	);

	// Whether the conflict toolbar shows is decided by the *index*, not by
	// whether the buffer still has markers — an agent resolving the markers in
	// the next pane must not remove the staging button. See ADR-0029.
	const relativePath = relativeToWorkspace(cwd, filePath);
	const isUnmerged = useWorkspaceGitStore((s) =>
		relativePath
			? (s.byWorkspaceId[workspaceId]?.conflictedPaths?.includes(
					relativePath,
				) ?? false)
			: false,
	);
	const conflictBlocks = useMemo(
		() => (isUnmerged ? parseConflicts(paneState?.content ?? "") : []),
		[isUnmerged, paneState?.content],
	);

	const acceptAllConflicts = useCallback(
		(choice: ResolveChoice) => {
			const content = useExplorerStore.getState().filePanes[paneId]?.content;
			if (content == null) return;
			const blocks = parseConflicts(content);
			if (blocks.length === 0) return;
			updateFileContent(paneId, resolveAll(content, blocks, choice));
		},
		[paneId, updateFileContent],
	);

	const resolveAndStage = useCallback(async () => {
		if (!relativePath) return;
		await saveFile(paneId);
		await git.stagePath(cwd, relativePath);
		// The scheduler cannot see an index write (`.git/index` is excluded from
		// the watcher on purpose), so refresh explicitly.
		const gitStore = useGitChangesStore.getState();
		await gitStore.fetchChanges(cwd, gitStore.baseBranch);
	}, [cwd, paneId, relativePath, saveFile]);

	const activeLayout = useActiveLayout();
	const mergeViewOpen = activeLayout
		? hasMergeView(activeLayout, paneId)
		: false;

	// Conflict state is derived from the index, so the Merge view tears itself
	// down when the merge finishes or is aborted — no explicit close path.
	useEffect(() => {
		if (!isUnmerged && mergeViewOpen) {
			void toggleMergeViewForPane(paneId);
		}
	}, [isUnmerged, mergeViewOpen, paneId]);

	const handleCursorLine = useCallback(
		(line: number) => {
			if (!mergeViewOpen) return;
			const index = conflictBlocks.findIndex(
				(b) => line >= b.startLine && line <= b.endLine,
			);
			setActiveConflictBlock(paneId, index === -1 ? null : index);
		},
		[conflictBlocks, mergeViewOpen, paneId],
	);

	useEffect(() => () => clearActiveConflictBlock(paneId), [paneId]);

	const { splitPaneWithPicker, closePane } = useSplitPane();

	const isDragSource = useDragPaneStore(
		(s) => s.isDragging && s.sourcePaneId === paneId,
	);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);

	// Register/unregister with the store when filePath changes
	useEffect(() => {
		registerFilePane(
			paneId,
			filePath,
			isDiff,
			diffSection,
			isDeleted,
			null,
			null,
		);
		return () => {
			unregisterFilePane(paneId);
		};
		// Re-register when filePath changes (e.g. user opened a different file in this pane slot).
		// register/unregisterFilePane are stable Zustand selectors, so listing them is free.
	}, [
		paneId,
		filePath,
		isDiff,
		diffSection,
		isDeleted,
		registerFilePane,
		unregisterFilePane,
	]);

	const handleContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({ x: e.clientX, y: e.clientY });
	};

	if (!paneState) {
		return (
			<div
				className="flex items-center justify-center h-full w-full"
				style={{
					backgroundColor: "var(--bg-primary)",
					color: "var(--fg-secondary)",
				}}
			>
				Loading…
			</div>
		);
	}

	if (paneState.loading) {
		return (
			<div
				className="flex items-center justify-center h-full w-full"
				style={{
					backgroundColor: "var(--bg-primary)",
					color: "var(--fg-secondary)",
				}}
			>
				Loading…
			</div>
		);
	}

	const showBanner = paneState.externallyChanged || paneState.deletedOnDisk;

	const action = (id: string) => () => {
		requestAnimationFrame(() => {
			focusEditor(paneId);
			triggerEditorAction(paneId, id);
		});
	};

	const isMarkdown =
		paneState.fileType === "text" && isMarkdownFile(paneState.fileName);

	// For a diff pane, the underlying real (repo-relative) path, sans "diff:" prefix.
	const diffRealPath =
		paneState.fileType === "diff"
			? paneState.filePath.replace(/^diff:/, "")
			: null;

	// Open the plain (non-diff) file backing this diff pane in the editor.
	// Undefined for deleted files (nothing on disk to open). Resolves via the
	// active workspace — safe because a focused diff pane is always in the active
	// workspace — and against its root folder, since the diff pane stores a
	// repo-relative path that fs.readFile can't consume directly.
	const openPlainFileFromDiff =
		diffRealPath && !paneState.isDeleted
			? () => {
					const wsState = useWorkspaceStore.getState();
					const workspaceId = wsState.activeWorkspaceId;
					const workspace = wsState.workspaces.find(
						(w) => w.id === workspaceId,
					);
					if (!workspaceId || !workspace) return;
					useExplorerStore
						.getState()
						.openFile(
							workspaceId,
							resolveWorkspacePath(workspace.rootFolder, diffRealPath),
						)
						.catch(() => {});
				}
			: undefined;

	const handlePrintMarkdown = async () => {
		const ws = useWorkspaceStore.getState();
		const layout = ws.getActiveLayout();
		const hasPreview = layout ? !!findPreviewForSource(layout, paneId) : false;
		// Printing operates on the preview pane's rendered DOM — open one first
		// if this file pane doesn't have a preview yet.
		if (!hasPreview) await toggleMarkdownPreviewForPane(paneId);
		requestPreviewPrint(paneId);
	};

	const markdownItems: ContextMenuItem[] = isMarkdown
		? [
				{
					label: "Toggle Preview",
					shortcut: sc("⇧⌘M", "Ctrl+Shift+M"),
					onClick: () => {
						toggleMarkdownPreviewForPane(paneId);
					},
				},
				{
					label: "Print",
					onClick: () => {
						handlePrintMarkdown();
					},
				},
				{ separator: true },
			]
		: [];

	const editorItems: ContextMenuItem[] =
		paneState.fileType === "text"
			? [
					{
						label: "Copy",
						shortcut: sc("⌘C", "Ctrl+C"),
						onClick: action("editor.action.clipboardCopyAction"),
					},
					{
						label: "Cut",
						shortcut: sc("⌘X", "Ctrl+X"),
						onClick: action("editor.action.clipboardCutAction"),
					},
					{
						label: "Paste",
						shortcut: sc("⌘V", "Ctrl+V"),
						onClick: action("editor.action.clipboardPasteAction"),
					},
					{
						label: "Select All",
						shortcut: sc("⌘A", "Ctrl+A"),
						onClick: action("editor.action.selectAll"),
					},
					{ separator: true },
					{
						label: "Format Document",
						onClick: action("editor.action.formatDocument"),
					},
					{
						label: "Toggle Word Wrap",
						onClick: action("abundio.toggleWordWrap"),
					},
					{
						label: "Find",
						shortcut: sc("⌘F", "Ctrl+F"),
						onClick: action("actions.find"),
					},
					{
						label: "Command Palette",
						shortcut: "F1",
						onClick: action("editor.action.quickCommand"),
					},
					{ separator: true },
				]
			: [];

	const paneItems: ContextMenuItem[] = [
		{
			label: "Split Right",
			shortcut: sc("⇧⌘V", "Ctrl+Alt+V"),
			onClick: () => splitPaneWithPicker(paneId, "vertical"),
		},
		{
			label: "Split Down",
			shortcut: sc("⇧⌘H", "Ctrl+Alt+H"),
			onClick: () => splitPaneWithPicker(paneId, "horizontal"),
		},
		{ separator: true },
		{
			label: "Close Pane",
			shortcut: sc("⇧⌘W", "Ctrl+Shift+W"),
			onClick: () => closePane(paneId),
		},
	];

	const contextMenuItems: ContextMenuItem[] = [
		...markdownItems,
		...editorItems,
		...paneItems,
	];

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on pane container
		// biome-ignore lint/a11y/noStaticElementInteractions: layout container, click-to-focus only
		<div
			className="relative w-full h-full flex flex-col"
			data-pane-id={paneId}
			style={{
				// Transparent so the workspace ambient gradient shows through the
				// editor/diff/image pane (matches transparent terminal panes).
				backgroundColor: "transparent",
				opacity: isDragSource ? 0.35 : 1,
				transition: "opacity 150ms ease",
			}}
			onClick={onFocus}
			onContextMenu={handleContextMenu}
		>
			{paneState && (
				<FilePaneTitleBar
					paneId={paneId}
					fileName={paneState.fileName}
					fileType={paneState.fileType}
					isDirty={paneState.isDirty}
					onSplitDown={() => splitPaneWithPicker(paneId, "horizontal")}
					onSplitRight={() => splitPaneWithPicker(paneId, "vertical")}
					onClose={() => closePane(paneId, paneState.fileName)}
				/>
			)}
			{showBanner && (
				<div className="relative z-10" style={{ flexShrink: 0 }}>
					<FileChangeBanner
						paneId={paneId}
						paneState={paneState}
						onReload={() => reloadPaneFromDisk(paneId)}
						onKeepEdits={() => dismissExternalChange(paneId)}
						onSave={() => saveFile(paneId)}
						onClose={() => closePane(paneId)}
					/>
				</div>
			)}
			{isUnmerged && relativePath && paneState.fileType === "text" && (
				<ConflictToolbar
					paneId={paneId}
					cwd={cwd}
					relativePath={relativePath}
					absolutePath={filePath}
					blocks={conflictBlocks}
					isDirty={paneState.isDirty}
					onAcceptAll={acceptAllConflicts}
					onResolveAndStage={resolveAndStage}
					mergeViewOpen={mergeViewOpen}
					onToggleMergeView={() => void toggleMergeViewForPane(paneId)}
					onToggleBase={() => void toggleMergeBase(paneId)}
				/>
			)}
			<div className="flex-1 min-h-0 relative">
				{paneState.fileType === "text" && (
					<CodeEditor
						tabId={paneId}
						isActive={isFocused}
						content={paneState.content ?? ""}
						language={paneState.language}
						initialEditorState={null}
						onChange={handleEditorChange}
						forceWordWrap={isMarkdown}
						onCursorLine={handleCursorLine}
					/>
				)}
				{paneState.fileType === "diff" &&
					paneState.diffOriginal != null &&
					paneState.diffModified != null &&
					diffRealPath != null && (
						<div className="absolute inset-0">
							<DiffViewer
								diff={{
									original: paneState.diffOriginal,
									modified: paneState.diffModified,
									filePath: diffRealPath,
								}}
								isActive={isFocused}
								onBack={() => {
									unregisterFilePane(paneId);
								}}
								onOpenFile={openPlainFileFromDiff}
							/>
						</div>
					)}
				{paneState.fileType === "image" && (
					<ImageViewer
						content={paneState.content ?? ""}
						mime={paneState.mime ?? "image/png"}
						fileName={paneState.fileName}
					/>
				)}
				{paneState.fileType === "binary" && (
					<UnsupportedFile fileName={paneState.fileName} size={0} />
				)}
			</div>

			{contextMenu && (
				<PaneContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}
			<PaneDropIndicator paneId={paneId} />
		</div>
	);
}

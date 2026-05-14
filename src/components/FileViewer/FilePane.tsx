import { useCallback, useEffect, useState } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import { useDragPaneStore } from "../../lib/dragPaneStore";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { toggleMarkdownPreviewForPane } from "../../lib/markdownPreview";
import { requestPreviewPrint } from "../../lib/markdownPreviewPrint";
import { findPreviewForSource } from "../../lib/paneTree";
import type { GitChangedFile } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { DiffViewer } from "../GitChanges/DiffViewer";
import { PaneDropIndicator } from "../PaneDropIndicator";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";
import { CodeEditor, focusEditor, triggerEditorAction } from "./CodeEditor";
import { FileChangeBanner } from "./FileChangeBanner";
import { FilePaneTitleBar } from "./FilePaneTitleBar";
import { ImageViewer } from "./ImageViewer";
import { UnsupportedFile } from "./UnsupportedFile";

interface FilePaneProps {
	paneId: string;
	filePath: string;
	isDiff?: boolean;
	diffSection?: GitChangedFile["section"];
	isFocused: boolean;
	onFocus: () => void;
}

export function FilePane({
	paneId,
	filePath,
	isDiff,
	diffSection,
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
		registerFilePane(paneId, filePath, isDiff, diffSection, null, null);
		return () => {
			unregisterFilePane(paneId);
		};
		// Re-register when filePath changes (e.g. user opened a different file in this pane slot)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId, filePath, isDiff]);

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
					shortcut: "⇧⌘M",
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
						shortcut: "⌘C",
						onClick: action("editor.action.clipboardCopyAction"),
					},
					{
						label: "Cut",
						shortcut: "⌘X",
						onClick: action("editor.action.clipboardCutAction"),
					},
					{
						label: "Paste",
						shortcut: "⌘V",
						onClick: action("editor.action.clipboardPasteAction"),
					},
					{
						label: "Select All",
						shortcut: "⌘A",
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
					{ label: "Find", shortcut: "⌘F", onClick: action("actions.find") },
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
			shortcut: "⇧⌘V",
			onClick: () => splitPaneWithPicker(paneId, "vertical"),
		},
		{
			label: "Split Down",
			shortcut: "⇧⌘H",
			onClick: () => splitPaneWithPicker(paneId, "horizontal"),
		},
		{ separator: true },
		{ label: "Close Pane", shortcut: "⇧⌘W", onClick: () => closePane(paneId) },
	];

	const contextMenuItems: ContextMenuItem[] = [
		...markdownItems,
		...editorItems,
		...paneItems,
	];

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on pane container
		<div
			className="relative w-full h-full flex flex-col"
			data-pane-id={paneId}
			style={{
				backgroundColor: "var(--bg-primary)",
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
					/>
				)}
				{paneState.fileType === "diff" &&
					paneState.diffOriginal != null &&
					paneState.diffModified != null && (
						<div className="absolute inset-0">
							<DiffViewer
								diff={{
									original: paneState.diffOriginal,
									modified: paneState.diffModified,
									filePath: paneState.filePath.replace(/^diff:/, ""),
								}}
								onBack={() => {
									unregisterFilePane(paneId);
								}}
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

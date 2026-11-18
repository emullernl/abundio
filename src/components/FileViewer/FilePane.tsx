import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveLayout } from "../../hooks/useActiveLayout";
import {
	editorShortcutLabelFor,
	shortcutLabelFor,
	useKeybindingOverrides,
} from "../../hooks/useShortcutLabel";
import { useSplitPane } from "../../hooks/useSplitPane";
import {
	diffRealPath as diffRealPathOf,
	parseCommitDiffKey,
} from "../../lib/commitDiffKey";
import {
	parseConflicts,
	type ResolveChoice,
	resolveAll,
} from "../../lib/conflictMarkers";
import { useDragPaneStore } from "../../lib/dragPaneStore";
import { git } from "../../lib/ipc";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { followRenderedLink } from "../../lib/markdownLinkOpen";
import { toggleMarkdownPreviewForPane } from "../../lib/markdownPreview";
import { printMarkdownPreview } from "../../lib/markdownPrint";
import {
	effectiveMarkdownView,
	type LinkModifiers,
} from "../../lib/markdownView";
import { registerMarkdownViewToggle } from "../../lib/markdownViewToggles";
import { registerResultEditor } from "../../lib/mergeScrollSync";
import {
	getActiveConflictBlock,
	initialMergeSelection,
	setActiveConflictBlock,
} from "../../lib/mergeSync";
import {
	hasMergeView,
	toggleMergeBase,
	toggleMergeViewForPane,
} from "../../lib/mergeView";
import {
	fileWindowTargetForPane,
	openFileWindow,
} from "../../lib/openFileWindow";
import { findPreviewForSource } from "../../lib/paneTree";
import { sc } from "../../lib/platform";
import {
	relativeToWorkspace,
	resolveWorkspacePath,
} from "../../lib/resolveWorkspacePath";
import type { GitChangedFile, MarkdownView } from "../../lib/types";
import { isUnifiedDiffFile } from "../../lib/unifiedDiff";
import { useExplorerStore } from "../../stores/explorerStore";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { DiffViewer } from "../GitChanges/DiffViewer";
import { PaneDropIndicator } from "../PaneDropIndicator";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";
import {
	CodeEditor,
	focusEditor,
	getLiveEditor,
	triggerEditorAction,
} from "./CodeEditor";
import { ConflictToolbar } from "./ConflictToolbar";
import { FileChangeBanner } from "./FileChangeBanner";
import { FilePaneTitleBar } from "./FilePaneTitleBar";
import { ImageViewer } from "./ImageViewer";
import { RenderedMarkdownView } from "./RenderedMarkdownView";
import { UnsupportedFile } from "./UnsupportedFile";

interface FilePaneProps {
	paneId: string;
	filePath: string;
	cwd: string;
	workspaceId: string;
	isDiff?: boolean;
	diffSource?: "git" | "file";
	diffSection?: GitChangedFile["section"];
	isDeleted?: boolean;
	isFocused: boolean;
	onFocus: () => void;
	/** Set when the file is not a pane of any layout (an **Orchestrator
	 *  tab**, ADR-0058): no splits, and closing closes that instead. */
	embedded?: {
		onClose: () => void;
		closeLabel: string;
		/** Where a link to another markdown file opens, instead of a Tab. */
		onOpenMarkdownLink?: (path: string) => void;
	};
	/** A markdown file's stored view (ADR-0061); absent: the setting's. */
	markdownView?: MarkdownView;
	/** Remember a new view (on the layout node, or the Orchestrator tab). */
	onMarkdownViewChange?: (view: MarkdownView) => void;
}

// A print asked for from the source view waits for the rendering, which is
// debounced (250ms in MarkdownRendered), plus a beat for Mermaid to settle.
const PRINT_AFTER_SWITCH_MS = 450;

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

export function FilePane({
	paneId,
	filePath,
	cwd,
	workspaceId,
	isDiff,
	diffSource,
	diffSection,
	isDeleted,
	isFocused,
	onFocus,
	embedded,
	markdownView,
	onMarkdownViewChange,
}: FilePaneProps) {
	const registerFilePane = useExplorerStore((s) => s.registerFilePane);
	const keyOverrides = useKeybindingOverrides();
	const loadCommitDiff = useExplorerStore((s) => s.loadCommitDiff);
	const unregisterFilePane = useExplorerStore((s) => s.unregisterFilePane);
	const paneState = useExplorerStore((s) => s.filePanes[paneId]);
	const updateFileContent = useExplorerStore((s) => s.updateFileContent);
	const reloadPaneFromDisk = useExplorerStore((s) => s.reloadPaneFromDisk);
	const dismissExternalChange = useExplorerStore(
		(s) => s.dismissExternalChange,
	);
	const saveFile = useExplorerStore((s) => s.saveFile);
	const openDiffAsText = useExplorerStore((s) => s.openDiffAsText);
	const viewFileAsDiff = useExplorerStore((s) => s.viewFileAsDiff);

	const handleEditorChange = useCallback(
		(content: string) => updateFileContent(paneId, content),
		[paneId, updateFileContent],
	);

	// Whether the conflict toolbar shows is decided by the *index*, not by
	// whether the buffer still has markers — an agent resolving the markers in
	// the next pane must not remove the staging button. See ADR-0029.
	const relativePath = relativeToWorkspace(cwd, filePath);
	// null = git has not answered for this workspace yet. Distinct from "no
	// conflicts": the teardown below must not act on an unanswered workspace.
	const conflictedPaths = useWorkspaceGitStore(
		(s) => s.byWorkspaceId[workspaceId]?.conflictedPaths ?? null,
	);
	const isUnmerged = relativePath
		? (conflictedPaths?.includes(relativePath) ?? false)
		: false;
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
	//
	// Gated on git having actually answered. Without that, a Merge view restored
	// from the persisted layout would be closed on every launch — the conflict
	// set is empty until the first fetch lands — and `updateLayout` would write
	// the stripped layout back to SQLite, so it would not come back.
	useEffect(() => {
		if (conflictedPaths === null) return;
		if (!isUnmerged && mergeViewOpen) {
			void toggleMergeViewForPane(paneId);
		}
	}, [conflictedPaths, isUnmerged, mergeViewOpen, paneId]);

	// Published for the Merge side panes *and* held locally for the navigator's
	// position readout, so both always agree on which block is current.
	const [activeBlock, setActiveBlock] = useState<number | null>(() =>
		getActiveConflictBlock(paneId),
	);

	/** Publish a block as the current one, without touching the caret. */
	const setCurrentBlock = useCallback(
		(index: number | null) => {
			setActiveBlock(index);
			setActiveConflictBlock(paneId, index);
		},
		[paneId],
	);

	const handleCursorLine = useCallback(
		(line: number) => {
			const index = conflictBlocks.findIndex(
				(b) => line >= b.startLine && line <= b.endLine,
			);
			// Moving the caret *into* a block selects it; moving it out keeps the
			// last one. "Current conflict" is a pointer you step through, not a
			// readout of where the caret happens to be — blanking it every time you
			// edited nearby would make the navigator flicker to "—" constantly.
			if (index !== -1) setCurrentBlock(index);
		},
		[conflictBlocks, setCurrentBlock],
	);

	/**
	 * Make a block the current one.
	 *
	 * The selection is published as state first and the caret follows, rather
	 * than the caret being the only source of truth: opening the Merge view
	 * re-parents the result pane, so its editor can be briefly unmounted at
	 * exactly the moment we want to select something. Publishing first means the
	 * side panes light up regardless, and the caret catches up once the editor
	 * is back.
	 */
	const selectBlock = useCallback(
		(blockIndex: number) => {
			const block = conflictBlocks[blockIndex];
			if (!block) return;
			setCurrentBlock(blockIndex);

			// Two frames, matching the pattern used elsewhere in this file for
			// post-layout editor work.
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const ed = getLiveEditor(paneId);
					if (!ed) return;
					// Land on the first line of content, not the marker — that is
					// where you would start reading.
					const line = Math.min(
						block.current.startLine,
						ed.getModel()?.getLineCount() ?? block.startLine,
					);
					ed.setPosition({ lineNumber: line, column: 1 });
					ed.revealLineInCenter(block.startLine);
					ed.focus();
				});
			});
		},
		[conflictBlocks, paneId, setCurrentBlock],
	);

	// A conflicted file always has a current conflict, in both the standard and
	// the Merge view — so the navigator reads "1/N" rather than "—/N" the moment
	// the toolbar appears, and the Merge view never opens on a uniformly dimmed
	// file with nothing marked.
	//
	// Pointer only: the caret is left alone. Opening a file to read one line
	// should not scroll you somewhere else. Explicit navigation moves the caret.
	//
	// An existing selection is respected, and the ref keeps this to once per
	// conflict session so it cannot fight the user's own navigation.
	const autoSelectedRef = useRef(false);
	useEffect(() => {
		if (!isUnmerged || conflictBlocks.length === 0) {
			autoSelectedRef.current = false;
			return;
		}
		if (autoSelectedRef.current) return;
		const target = initialMergeSelection(activeBlock, conflictBlocks.length);
		if (target === null) return;
		autoSelectedRef.current = true;
		setCurrentBlock(target);
	}, [isUnmerged, conflictBlocks.length, activeBlock, setCurrentBlock]);

	// A resolved block shifts every index after it, so clamp rather than leave
	// the navigator pointing past the end.
	useEffect(() => {
		if (activeBlock !== null && activeBlock >= conflictBlocks.length) {
			setCurrentBlock(
				conflictBlocks.length === 0 ? null : conflictBlocks.length - 1,
			);
		}
	}, [activeBlock, conflictBlocks.length, setCurrentBlock]);

	// Deliberately not cleared on unmount. Opening the Merge view re-parents the
	// result pane, so this component unmounts and remounts as part of a layout
	// change rather than a close — clearing here would drop the user's place
	// exactly when the side panes appear to use it. The registry holds one
	// number per pane id, so the residue is negligible.

	// The result pane is the hub the side panes scroll against. Registered only
	// while the Merge view is open — outside it there is nothing to sync with.
	const [resultEditorReady, setResultEditorReady] = useState(false);
	useEffect(() => {
		if (!mergeViewOpen || !resultEditorReady) return;
		const ed = getLiveEditor(paneId);
		if (!ed) return;
		return registerResultEditor(paneId, ed);
	}, [mergeViewOpen, resultEditorReady, paneId]);

	const { splitPaneWithPicker, closePane } = useSplitPane();

	// ── Markdown view (ADR-0061) ──
	const isMarkdown =
		paneState?.fileType === "text" && isMarkdownFile(paneState.fileName);
	const openRendered = useSettingsStore((s) => s.markdownOpenRendered);
	// The view picked here, shown at once; the stored one catches up through
	// the layout (or the Orchestrator tab) a moment later.
	const [pickedView, setPickedView] = useState<MarkdownView | undefined>(
		undefined,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new stored view or file drops the local pick
	useEffect(() => {
		setPickedView(undefined);
	}, [markdownView, filePath]);
	const view = effectiveMarkdownView({
		stored: pickedView ?? markdownView,
		openRendered,
		isMarkdown,
		isUnmerged,
	});
	const viewRef = useRef(view);
	viewRef.current = view;
	const changeView = useCallback(
		(next: MarkdownView) => {
			setPickedView(next);
			onMarkdownViewChange?.(next);
		},
		[onMarkdownViewChange],
	);
	// Monaco mounts the first time the source is shown and then stays, hidden
	// under the rendering, so its undo history and caret survive a switch.
	const [sourceMounted, setSourceMounted] = useState(view === "source");
	useEffect(() => {
		if (view === "source") setSourceMounted(true);
	}, [view]);

	// Cmd/Ctrl+Shift+M. Registered while this is a markdown pane; a conflicted
	// one stays on its source, so the switch does nothing there.
	useEffect(() => {
		if (!isMarkdown) return;
		return registerMarkdownViewToggle(paneId, () => {
			if (isUnmerged) return;
			changeView(viewRef.current === "rendered" ? "source" : "rendered");
		});
	}, [isMarkdown, isUnmerged, paneId, changeView]);

	// Find in the rendering: the same "Find" shortcut that opens a terminal's
	// search bar (`searchPaneId`).
	const findOpen = useWorkspaceStore((s) => s.searchPaneId === paneId);
	const setFindOpen = useCallback(
		(open: boolean) => {
			const ws = useWorkspaceStore.getState();
			if ((ws.searchPaneId === paneId) !== open) ws.toggleSearch(paneId);
		},
		[paneId],
	);
	useEffect(() => {
		if (view === "source" && findOpen) setFindOpen(false);
	}, [view, findOpen, setFindOpen]);

	// A jump to a line (search result, terminal link, `file open --line`)
	// means the source. The editor takes the line once it is shown.
	const gotoThisFile = useExplorerStore(
		(s) =>
			s.pendingGotoLine != null &&
			s.pendingGotoLine.filePath === s.filePanes[paneId]?.filePath,
	);
	useEffect(() => {
		if (gotoThisFile && isFocused && viewRef.current === "rendered") {
			changeView("source");
		}
	}, [gotoThisFile, isFocused, changeView]);

	const renderedRef = useRef<HTMLDivElement | null>(null);
	const doPrint = useCallback(() => {
		if (renderedRef.current) printMarkdownPreview(renderedRef.current);
	}, []);
	const [printPending, setPrintPending] = useState(false);
	useEffect(() => {
		if (!printPending || view !== "rendered") return;
		const t = setTimeout(() => {
			setPrintPending(false);
			doPrint();
		}, PRINT_AFTER_SWITCH_MS);
		return () => clearTimeout(t);
	}, [printPending, view, doPrint]);

	const onOpenMarkdownLink = embedded?.onOpenMarkdownLink;
	const onLinkClick = useCallback(
		(href: string | undefined, modifiers?: LinkModifiers) => {
			const path = useExplorerStore.getState().filePanes[paneId]?.filePath;
			if (!path) return;
			followRenderedLink({
				href,
				modifiers,
				baseDir: dirOf(path),
				workspaceId,
				workspaceRoot: cwd,
				scrollEl: renderedRef.current,
				openInTab: onOpenMarkdownLink,
			});
		},
		[paneId, workspaceId, cwd, onOpenMarkdownLink],
	);

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
			diffSource,
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
		diffSource,
		diffSection,
		isDeleted,
		registerFilePane,
		unregisterFilePane,
	]);

	// A Commit diff pane restored from a saved layout has no content (diffs
	// live only in memory); fetch it once. Live `diff:` panes are refreshed by
	// the file watcher instead, and a commit never changes.
	const needsCommitDiff =
		paneState?.fileType === "diff" &&
		paneState.diffOriginal == null &&
		parseCommitDiffKey(paneState.filePath) != null;
	useEffect(() => {
		if (needsCommitDiff) loadCommitDiff(paneId, cwd);
	}, [needsCommitDiff, paneId, cwd, loadCommitDiff]);

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

	// For a diff pane, the underlying real (repo-relative) path, sans its key
	// prefix (`diff:` or a Commit diff pane's `diff@<oid>:`).
	const diffRealPath =
		paneState.fileType === "diff" ? diffRealPathOf(paneState.filePath) : null;
	const isCommitDiff = parseCommitDiffKey(paneState.filePath) != null;
	const isStandaloneDiff = paneState.diffSource === "file";
	const isPatchFile =
		paneState.fileType === "text" &&
		isUnifiedDiffFile(paneState.filePath, paneState.content ?? "");

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

	// Prints the pane's own rendering, switching to it first from the source.
	const handlePrintMarkdown = () => {
		if (view === "rendered") doPrint();
		else if (!isUnmerged) {
			changeView("rendered");
			setPrintPending(true);
		}
	};

	const hasPreview =
		!embedded && activeLayout
			? !!findPreviewForSource(activeLayout, paneId)
			: false;
	const markdownItems: ContextMenuItem[] = isMarkdown
		? [
				...(isUnmerged
					? []
					: [
							{
								label: view === "rendered" ? "Show Source" : "Show Rendered",
								shortcut: shortcutLabelFor(
									"toggle-markdown-preview",
									keyOverrides,
								),
								onClick: () =>
									changeView(view === "rendered" ? "source" : "rendered"),
							},
						]),
				// A Preview pane is a pane of a layout: none in an Orchestrator tab.
				...(embedded
					? []
					: [
							{
								label: hasPreview ? "Close Preview" : "Open Preview Beside",
								onClick: () => {
									void toggleMarkdownPreviewForPane(paneId);
								},
							},
						]),
				...(isUnmerged
					? []
					: [{ label: "Print", onClick: handlePrintMarkdown }]),
				{ separator: true },
			]
		: [];

	const editorItems: ContextMenuItem[] =
		paneState.fileType === "text" && view === "source"
			? [
					{
						label: "Copy",
						shortcut: editorShortcutLabelFor(
							"editor.action.clipboardCopyAction",
							sc("⌘C", "Ctrl+C"),
							keyOverrides,
						),
						onClick: action("editor.action.clipboardCopyAction"),
					},
					{
						label: "Cut",
						shortcut: editorShortcutLabelFor(
							"editor.action.clipboardCutAction",
							sc("⌘X", "Ctrl+X"),
							keyOverrides,
						),
						onClick: action("editor.action.clipboardCutAction"),
					},
					{
						label: "Paste",
						shortcut: editorShortcutLabelFor(
							"editor.action.clipboardPasteAction",
							sc("⌘V", "Ctrl+V"),
							keyOverrides,
						),
						onClick: action("editor.action.clipboardPasteAction"),
					},
					{
						label: "Select All",
						shortcut: editorShortcutLabelFor(
							"editor.action.selectAll",
							sc("⌘A", "Ctrl+A"),
							keyOverrides,
						),
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
						shortcut: editorShortcutLabelFor(
							"actions.find",
							sc("⌘F", "Ctrl+F"),
							keyOverrides,
						),
						onClick: action("actions.find"),
					},
					{
						label: "Command Palette",
						shortcut: editorShortcutLabelFor(
							"editor.action.quickCommand",
							"F1",
							keyOverrides,
						),
						onClick: action("editor.action.quickCommand"),
					},
					{ separator: true },
				]
			: [];

	const paneItems: ContextMenuItem[] = embedded
		? [{ label: embedded.closeLabel, onClick: embedded.onClose }]
		: [
				{
					label: "Split Right",
					shortcut: shortcutLabelFor("split-vertical", keyOverrides),
					onClick: () => splitPaneWithPicker(paneId, "vertical"),
				},
				{
					label: "Split Down",
					shortcut: shortcutLabelFor("split-horizontal", keyOverrides),
					onClick: () => splitPaneWithPicker(paneId, "horizontal"),
				},
				{ separator: true },
				{
					label: "Close Pane",
					shortcut: shortcutLabelFor("close-pane", keyOverrides),
					onClick: () => closePane(paneId),
				},
			];

	// The window shows what this pane shows: a diff pane gives a diff window.
	const paneTarget = fileWindowTargetForPane(paneId, null, {
		[paneId]: paneState,
	});
	const windowTarget =
		paneTarget?.kind === "text" && isMarkdown
			? { ...paneTarget, view }
			: paneTarget;
	const windowItems: ContextMenuItem[] = windowTarget
		? [
				{
					label: "Open in Separate Window",
					shortcut: shortcutLabelFor("open-markdown-window", keyOverrides),
					onClick: () => {
						void openFileWindow(workspaceId, windowTarget);
					},
				},
				{ separator: true },
			]
		: [];

	const contextMenuItems: ContextMenuItem[] = [
		...markdownItems,
		...windowItems,
		...(isPatchFile && paneState.fileType === "text"
			? [
					{
						label: "View Diff",
						onClick: () => viewFileAsDiff(paneId),
					},
				]
			: []),
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
					onSplitDown={
						embedded
							? undefined
							: () => splitPaneWithPicker(paneId, "horizontal")
					}
					onSplitRight={
						embedded ? undefined : () => splitPaneWithPicker(paneId, "vertical")
					}
					onClose={
						embedded?.onClose ?? (() => closePane(paneId, paneState.fileName))
					}
					closeLabel={embedded?.closeLabel}
					markdown={
						isMarkdown
							? {
									view,
									onViewChange: changeView,
									conflicted: isUnmerged,
									onFind: () => setFindOpen(true),
									onPrint: doPrint,
									onOpenInWindow: windowTarget
										? () => void openFileWindow(workspaceId, windowTarget)
										: undefined,
								}
							: undefined
					}
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
						onClose={embedded?.onClose ?? (() => closePane(paneId))}
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
					activeBlock={activeBlock}
					onNavigate={selectBlock}
				/>
			)}
			<div className="flex-1 min-h-0 relative">
				{paneState.fileType === "text" && view === "rendered" && (
					<div className="absolute inset-0 flex flex-col">
						<RenderedMarkdownView
							ref={renderedRef}
							content={paneState.content ?? ""}
							baseDir={dirOf(paneState.filePath)}
							onLinkClick={onLinkClick}
							findOpen={findOpen}
							onCloseFind={() => setFindOpen(false)}
							layout="pane"
							focused={isFocused}
						/>
					</div>
				)}
				{paneState.fileType === "text" &&
					(view === "source" || sourceMounted) && (
						<div
							className="absolute inset-0"
							style={view === "source" ? undefined : { display: "none" }}
						>
							<CodeEditor
								tabId={paneId}
								// Never while hidden, or it would take keyboard focus and
								// typing would edit a text nobody can see.
								isActive={isFocused && view === "source"}
								content={paneState.content ?? ""}
								language={paneState.language}
								initialEditorState={null}
								onChange={handleEditorChange}
								forceWordWrap={isMarkdown}
								onCursorLine={handleCursorLine}
								activeConflictBlock={activeBlock}
								onEditorMounted={() => setResultEditorReady(true)}
							/>
						</div>
					)}
				{paneState.fileType === "diff" &&
					paneState.diffOriginal == null &&
					paneState.diffLoadFailed && (
						<div
							className="absolute inset-0 flex items-center justify-center text-center"
							style={{
								color: "var(--fg-secondary)",
								fontSize: 13,
								padding: "0 24px",
								backgroundColor: "var(--bg-primary)",
							}}
						>
							This commit is no longer in the repository — it may have been
							rebased away. Close this pane, or open the file from the Commits
							section again.
						</div>
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
								language={paneState.language}
								onBack={
									paneState.diffSection
										? () => unregisterFilePane(paneId)
										: undefined
								}
								onOpenFile={
									isStandaloneDiff
										? () => openDiffAsText(paneId)
										: paneState.diffSection || isCommitDiff
											? openPlainFileFromDiff
											: undefined
								}
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

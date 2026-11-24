import { useWorkspaceStore } from "../stores/workspaceStore";
import { isMarkdownFile } from "./isMarkdownFile";
import {
	collectFilePaneIds,
	findNode,
	findPreviewForSource,
	parseTabLayout,
	removeNode,
	setFileNodePdfPosition,
	setFileNodeView,
	wrapInSplit,
} from "./paneTree";
import type { PdfPosition } from "./pdfView";
import type { MarkdownView, PaneNode } from "./types";

function makePreviewNode(sourcePaneId: string): PaneNode {
	return { type: "preview", id: crypto.randomUUID(), sourcePaneId };
}

/**
 * Build the layout for a freshly-opened file: one File pane. A markdown file
 * shows its own rendered view (ADR-0061), so no Preview pane is added; `view`
 * pins the view (a link, `file open --preview`), else the pane follows the
 * **Open markdown rendered** setting.
 */
export function buildFilePaneLayout(
	filePath: string,
	view?: MarkdownView,
): {
	layout: PaneNode;
	filePaneId: string;
} {
	const filePaneId = crypto.randomUUID();
	const layout: PaneNode = {
		type: "file",
		id: filePaneId,
		filePath,
		...(view && isMarkdownFile(filePath) ? { markdownView: view } : {}),
	};
	return { layout, filePaneId };
}

/**
 * Open or close the **Preview pane** beside a markdown File pane in the active
 * tab (the pane menu's Open Preview Beside / Close Preview). Accepts either
 * the file pane or its preview pane.
 */
export async function toggleMarkdownPreviewForPane(
	paneId: string,
): Promise<void> {
	const ws = useWorkspaceStore.getState();
	const tab = ws.getActiveTab();
	const layout = ws.getActiveLayout();
	if (!tab || !layout) return;

	const node = findNode(layout, paneId);
	// Allow invoking from the preview pane itself — resolve to its source.
	const filePaneId = node?.type === "preview" ? node.sourcePaneId : paneId;
	const fileNode = findNode(layout, filePaneId);
	if (fileNode?.type !== "file" || !isMarkdownFile(fileNode.filePath)) return;

	const existing = findPreviewForSource(layout, filePaneId);
	if (existing) {
		const next = removeNode(layout, existing.id);
		if (!next) return;
		await ws.updateLayout(tab.id, next);
		return;
	}

	const next = wrapInSplit(
		layout,
		filePaneId,
		makePreviewNode(filePaneId),
		"vertical",
	);
	await ws.updateLayout(tab.id, next);
}

/**
 * Remove preview panes whose source file pane is no longer a markdown file
 * (e.g. a `.md` renamed to `.txt`). Returns a new tree only if something was
 * removed.
 */
export function pruneNonMarkdownPreviews(tree: PaneNode): PaneNode {
	let result: PaneNode = tree;
	for (const fileId of collectFilePaneIds(tree)) {
		const fileNode = findNode(result, fileId);
		if (fileNode?.type !== "file" || isMarkdownFile(fileNode.filePath))
			continue;
		const preview = findPreviewForSource(result, fileId);
		if (!preview) continue;
		const next = removeNode(result, preview.id);
		if (next) result = next;
	}
	return result;
}

/**
 * Remember a File pane's markdown view on its node (ADR-0061), in whichever
 * Tab of the Workspace holds it.
 */
/** Remember a PDF File pane's page and zoom on its layout node. */
export async function setPdfPositionForPane(
	workspaceId: string,
	paneId: string,
	position: PdfPosition,
): Promise<void> {
	const ws = useWorkspaceStore.getState();
	const workspace = ws.workspaces.find((w) => w.id === workspaceId);
	if (!workspace) return;
	for (const tab of workspace.tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout || !findNode(layout, paneId)) continue;
		const next = setFileNodePdfPosition(layout, paneId, position);
		if (next !== layout) await ws.updateLayout(tab.id, next);
		return;
	}
}

export async function setMarkdownViewForPane(
	workspaceId: string,
	paneId: string,
	view: MarkdownView,
): Promise<void> {
	const ws = useWorkspaceStore.getState();
	const workspace = ws.workspaces.find((w) => w.id === workspaceId);
	if (!workspace) return;
	for (const tab of workspace.tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout || !findNode(layout, paneId)) continue;
		const next = setFileNodeView(layout, paneId, view);
		if (next !== layout) await ws.updateLayout(tab.id, next);
		return;
	}
}

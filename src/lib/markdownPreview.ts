import { useWorkspaceStore } from "../stores/workspaceStore";
import { isMarkdownFile } from "./isMarkdownFile";
import {
	collectFilePaneIds,
	findNode,
	findPreviewForSource,
	removeNode,
	wrapInSplit,
} from "./paneTree";
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

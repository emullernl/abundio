import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { isMarkdownFile } from "./isMarkdownFile";
import {
	collectFilePaneIds,
	findNode,
	findPreviewForSource,
	removeNode,
	wrapInSplit,
} from "./paneTree";
import type { PaneNode } from "./types";

// In-memory, per-session suppression. When the user manually closes a preview
// for a file pane, we don't re-spawn it automatically until they reopen it.
// Not persisted — a fresh session starts with auto-open rules in full effect.
const suppressed = new Set<string>();

export function suppressMarkdownPreview(filePaneId: string): void {
	suppressed.add(filePaneId);
}

export function unsuppressMarkdownPreview(filePaneId: string): void {
	suppressed.delete(filePaneId);
}

export function isMarkdownPreviewSuppressed(filePaneId: string): boolean {
	return suppressed.has(filePaneId);
}

function makePreviewNode(sourcePaneId: string): PaneNode {
	return { type: "preview", id: crypto.randomUUID(), sourcePaneId };
}

/**
 * Build the layout for a freshly-opened file. Markdown files get a preview
 * pane spawned beside them (vertical split, 50/50) when auto-open is enabled.
 * Used only on user-initiated file opens — never on layout restore.
 */
export function buildFilePaneLayout(filePath: string): {
	layout: PaneNode;
	filePaneId: string;
} {
	const filePaneId = crypto.randomUUID();
	const fileNode: PaneNode = { type: "file", id: filePaneId, filePath };
	const autoOpen = useSettingsStore.getState().markdownPreviewAutoOpen;
	if (!autoOpen || !isMarkdownFile(filePath)) {
		return { layout: fileNode, filePaneId };
	}
	return {
		layout: {
			type: "split",
			id: crypto.randomUUID(),
			direction: "vertical",
			ratio: 0.5,
			first: fileNode,
			second: makePreviewNode(filePaneId),
		},
		filePaneId,
	};
}

/**
 * Toggle the markdown preview for a pane in the active tab. Accepts either a
 * markdown file pane or its preview pane. Closing a preview this way suppresses
 * auto-open for that file pane; opening one clears the suppression.
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
		suppressMarkdownPreview(filePaneId);
		await ws.updateLayout(tab.id, next);
		return;
	}

	unsuppressMarkdownPreview(filePaneId);
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

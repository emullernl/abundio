import type { FilePaneState } from "../stores/explorerStore";
import { markdownWindows } from "./ipc";
import { isMarkdownFile } from "./isMarkdownFile";
import { findNode } from "./paneTree";
import { isMac } from "./platform";
import type { PaneNode } from "./types";

/**
 * Every way into a **Markdown window** goes through here (ADR-0046): the
 * explorer menu and Cmd/Ctrl+click, the File and Preview pane menus, and the
 * `open-markdown-window` command.
 */
export function openMarkdownWindow(
	workspaceId: string,
	filePath: string,
): Promise<void> {
	return markdownWindows.open(workspaceId, filePath).catch((e) => {
		console.error("[openMarkdownWindow] failed:", e);
	});
}

/** Whether an explorer click opens a Markdown window instead of a Tab:
 *  Cmd+click on macOS, Ctrl+click elsewhere (on macOS Ctrl+click is the
 *  context menu), and only for a markdown file. */
export function clickOpensMarkdownWindow(
	e: { metaKey: boolean; ctrlKey: boolean },
	filePath: string,
	mac: boolean = isMac,
): boolean {
	if (!isMarkdownFile(filePath)) return false;
	return mac ? e.metaKey : e.ctrlKey;
}

/** The markdown file a pane shows: a File pane's own file, or a Preview
 *  pane's source file. `null` for anything else. */
export function markdownFileForPane(
	paneId: string,
	layout: PaneNode | null,
	filePanes: Readonly<Record<string, FilePaneState | undefined>>,
): string | null {
	let fileId = paneId;
	const node = layout ? findNode(layout, paneId) : null;
	if (node?.type === "preview") fileId = node.sourcePaneId;
	const path = filePanes[fileId]?.filePath;
	return path && isMarkdownFile(path) ? path : null;
}

import type { FilePaneState } from "../stores/explorerStore";
import { parseCommitDiffKey } from "./commitDiffKey";
import { fileWindowKindFor } from "./fileWindowKind";
import { type FileWindowTarget, fileWindows } from "./ipc";
import { findNode } from "./paneTree";
import { isMac } from "./platform";
import type { PaneNode } from "./types";

/**
 * Every way into a **File window** goes through here (ADR-0046, ADR-0049): the
 * explorer menu and Cmd/Ctrl+click, the File and Preview pane menus, the Git
 * changes and Commits **Row menus**, and the `open-markdown-window` command
 * (its id predates File windows and is kept so users' rebinds survive).
 */
export function openFileWindow(
	workspaceId: string,
	target: FileWindowTarget,
): Promise<void> {
	return fileWindows.open(workspaceId, target).catch((e) => {
		console.error("[openFileWindow] failed:", e);
	});
}

/** The File window target for a file on disk, or `null` when it has none. */
export function fileWindowTargetForPath(path: string): FileWindowTarget | null {
	const kind = fileWindowKindFor(path);
	return kind ? { kind, filePath: path } : null;
}

/** Opens a file on disk in its File window; does nothing for a file that has
 *  none (menus hide the item for those, so this is only a guard). */
export function openFileWindowForPath(
	workspaceId: string,
	path: string,
): Promise<void> {
	const target = fileWindowTargetForPath(path);
	return target ? openFileWindow(workspaceId, target) : Promise.resolve();
}

/** Whether an explorer click opens a File window instead of a Tab:
 *  Cmd+click on macOS, Ctrl+click elsewhere (on macOS Ctrl+click is the
 *  context menu), and only for a file that has a File window. */
export function clickOpensFileWindow(
	e: { metaKey: boolean; ctrlKey: boolean },
	filePath: string,
	mac: boolean = isMac,
): boolean {
	if (!fileWindowKindFor(filePath)) return false;
	return mac ? e.metaKey : e.ctrlKey;
}

/**
 * What a pane shows, as a File window target: the window shows what the pane
 * shows. A text or image File pane gives its file; a Preview pane gives its
 * source file; a live diff pane gives its diff; a Commit diff pane gives that
 * commit's diff. `null` for a binary pane, a terminal, or an unknown id.
 */
export function fileWindowTargetForPane(
	paneId: string,
	layout: PaneNode | null,
	filePanes: Readonly<Record<string, FilePaneState | undefined>>,
): FileWindowTarget | null {
	let fileId = paneId;
	const node = layout ? findNode(layout, paneId) : null;
	if (node?.type === "preview") fileId = node.sourcePaneId;
	const pane = filePanes[fileId];
	if (!pane?.filePath) return null;
	switch (pane.fileType) {
		case "text":
			return { kind: "text", filePath: pane.filePath };
		case "image":
			return { kind: "image", filePath: pane.filePath };
		case "diff": {
			// A `.diff`/`.patch` file shown as a diff is still a file on disk.
			if (pane.diffSource === "file") {
				return { kind: "text", filePath: pane.filePath };
			}
			const commit = parseCommitDiffKey(pane.filePath);
			if (commit) {
				return {
					kind: "commit-diff",
					filePath: commit.path,
					commitOid: commit.oid,
				};
			}
			if (!pane.filePath.startsWith("diff:")) return null;
			return {
				kind: "diff",
				filePath: pane.filePath.slice("diff:".length),
				diffSection: pane.diffSection ?? "unstaged",
			};
		}
		default:
			return null;
	}
}

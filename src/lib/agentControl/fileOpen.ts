/**
 * Agent control's `file open` (ADR-0058): show the user a file of a
 * Workspace. Rust has already resolved the path and checked it lies inside
 * the target Workspace; this decides where it lands.
 *
 * - `--window`: a **File window**.
 * - From the Orchestrator: an **Orchestrator tab**, without opening the
 *   file's Workspace.
 * - Otherwise: a new Tab of the file's Workspace (opened in the background
 *   first, if it is not Opened), or the one already showing it.
 *
 * Focus moves only with `--focus`, as everywhere in Agent control.
 */

import { useExplorerStore } from "../../stores/explorerStore";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	type FileWindowTarget,
	git as gitApi,
	type MarkdownView,
} from "../ipc";
import { liveDiff } from "../liveDiff";
import { setMarkdownViewForPane } from "../markdownPreview";
import { fileWindowTargetForPath, openFileWindow } from "../openFileWindow";
import { openOrchestratorFile } from "../orchestratorTabs";
import { findFilePaneByPath, parseTabLayout } from "../paneTree";
import { isOrchestrator } from "../workspaceKind";
import { type ControlCaller, ControlError, type ControlRequest } from "./types";

type FileOpen = Extract<ControlRequest, { op: "file.open" }>;

/** What `file open` answers: where the file went. */
export interface FileOpenReply {
	opened: "window" | "orchestrator-tab" | "tab";
	path: string;
	workspaceId: string;
}

/**
 * The markdown view a call asks for (ADR-0061): `--line` means the source,
 * `--preview` the rendering whatever the setting; neither, the setting.
 * Only a file has views. Pure.
 */
export function fileOpenView(
	request: Pick<FileOpen, "line" | "preview" | "diff" | "commit">,
): MarkdownView | undefined {
	if (request.diff || request.commit) return undefined;
	if (request.line) return "source";
	return request.preview ? "rendered" : undefined;
}

/** Where a call lands, from who calls and how. Pure. */
export function fileOpenPlace(
	request: Pick<FileOpen, "window">,
	callerIsOrchestrator: boolean,
): FileOpenReply["opened"] {
	if (request.window) return "window";
	return callerIsOrchestrator ? "orchestrator-tab" : "tab";
}

/**
 * Carries out `file open` for `caller`, aimed at `workspaceId`.
 * `ensureOpened` opens that Workspace in the background when a Tab or File
 * window needs it Opened (an Orchestrator tab does not).
 */
export async function openFileFor(
	caller: ControlCaller,
	request: FileOpen,
	workspaceId: string,
	ensureOpened: () => Promise<void>,
): Promise<FileOpenReply> {
	const ws = () =>
		useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
	const callerWs = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === caller.workspaceId);
	const place = fileOpenPlace(request, isOrchestrator(callerWs));
	const kind = request.commit ? "commit" : request.diff ? "diff" : "file";
	const view = fileOpenView(request);
	const reply = { opened: place, path: request.path, workspaceId };

	if (place === "orchestrator-tab") {
		const target = ws();
		if (!target)
			throw new ControlError(
				"not_found",
				"that Workspace is not loaded in this Window",
			);
		// The same answer as a Tab gives, and no dead tab kept for a commit
		// that does not exist or never touched the file.
		if (kind === "commit" && request.commit) {
			await gitApi
				.commitFileDiff(target.rootFolder, request.commit, request.rel)
				.catch(() => {
					throw new ControlError(
						"not_found",
						`no such commit, or it did not change ${request.rel}`,
					);
				});
		}
		const made = await openOrchestratorFile(
			{
				workspaceId,
				kind,
				path: kind === "file" ? request.path : request.rel,
				commitOid: request.commit,
				view,
			},
			{ focus: request.focus },
		);
		if (request.focus) {
			useOrchestratorStore.getState().set({ fileTabFocused: true });
		}
		// Only for a tab that is on screen: a pending line nobody consumes
		// would wait for whichever File pane next opens this file, anywhere.
		const shown = useOrchestratorStore.getState().selectedTabId === made.id;
		if (request.line && kind === "file" && shown) {
			useExplorerStore
				.getState()
				.setPendingGotoLine({ filePath: request.path, line: request.line });
		}
		return reply;
	}

	await ensureOpened();
	const target = ws();
	if (!target) {
		throw new ControlError(
			"not_found",
			"that Workspace is not loaded in this Window",
		);
	}

	if (place === "window") {
		const windowTarget =
			kind === "commit" && request.commit
				? {
						kind: "commit-diff" as const,
						filePath: request.rel,
						commitOid: request.commit,
					}
				: kind === "diff"
					? {
							kind: "diff" as const,
							filePath: request.rel,
							diffSection:
								(await liveDiff(target.rootFolder, request.rel))?.section ??
								"unstaged",
						}
					: withView(fileWindowTargetForPath(request.path), view);
		if (!windowTarget) {
			throw new ControlError(
				"not_a_file",
				"this file cannot be shown in a window (binary or unsupported)",
			);
		}
		await openFileWindow(workspaceId, windowTarget);
		return reply;
	}

	// A Tab of the file's Workspace.
	const explorer = useExplorerStore.getState();
	const activate = request.focus;
	if (kind === "commit" && request.commit) {
		const d = await gitApi
			.commitFileDiff(target.rootFolder, request.commit, request.rel)
			.catch(() => {
				throw new ControlError(
					"not_found",
					`no such commit, or it did not change ${request.rel}`,
				);
			});
		explorer.openCommitDiff(
			workspaceId,
			request.commit,
			request.rel,
			d.original,
			d.modified,
			false,
			{ activate },
		);
	} else if (kind === "diff") {
		const d = await liveDiff(target.rootFolder, request.rel);
		if (!d) throw new ControlError("not_found", `no changes to ${request.rel}`);
		explorer.openDiff(
			workspaceId,
			request.rel,
			d.original,
			d.modified,
			d.section,
			false,
			{ activate },
		);
	} else {
		await explorer.openFile(workspaceId, request.path, { activate, view });
		// A Tab that already showed the file takes the asked-for view too.
		if (view) await setViewOfOpenFile(workspaceId, request.path, view);
		if (request.line) {
			explorer.setPendingGotoLine({
				filePath: request.path,
				line: request.line,
			});
		}
	}
	// --focus: the Workspace becomes Active too.
	if (
		request.focus &&
		useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
	) {
		useWorkspaceStore.getState().beginWorkspaceSwitch(workspaceId);
	}
	return reply;
}

/** A text File window target with the asked-for view. */
function withView(
	target: FileWindowTarget | null,
	view: MarkdownView | undefined,
): FileWindowTarget | null {
	return target?.kind === "text" && view ? { ...target, view } : target;
}

/** Sets the view of the File pane showing `path` in a Tab of the Workspace. */
async function setViewOfOpenFile(
	workspaceId: string,
	path: string,
	view: MarkdownView,
): Promise<void> {
	const workspace = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	for (const tab of workspace?.tabs ?? []) {
		const layout = parseTabLayout(tab.layoutJson);
		const pane = layout ? findFilePaneByPath(layout, path) : null;
		if (pane) {
			await setMarkdownViewForPane(workspaceId, pane.id, view);
			return;
		}
	}
}

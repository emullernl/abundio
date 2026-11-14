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
import { git as gitApi } from "../ipc";
import { liveDiff } from "../liveDiff";
import { fileWindowTargetForPath, openFileWindow } from "../openFileWindow";
import { openOrchestratorFile } from "../orchestratorTabs";
import { isOrchestrator } from "../workspaceKind";
import { type ControlCaller, ControlError, type ControlRequest } from "./types";

type FileOpen = Extract<ControlRequest, { op: "file.open" }>;

/** What `file open` answers: where the file went. */
export interface FileOpenReply {
	opened: "window" | "orchestrator-tab" | "tab";
	path: string;
	workspaceId: string;
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
	const reply = { opened: place, path: request.path, workspaceId };

	if (place === "orchestrator-tab") {
		if (!ws())
			throw new ControlError(
				"not_found",
				"that Workspace is not loaded in this Window",
			);
		await openOrchestratorFile(
			{
				workspaceId,
				kind,
				path: kind === "file" ? request.path : request.rel,
				commitOid: request.commit,
				preview: request.preview,
			},
			{ focus: request.focus },
		);
		if (request.focus) {
			useOrchestratorStore.getState().set({ fileTabFocused: true });
		}
		if (request.line && kind === "file") {
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
					: fileWindowTargetForPath(request.path);
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
		await explorer.openFile(workspaceId, request.path, { activate });
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

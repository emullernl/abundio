import { fileWindows } from "./ipc";

/**
 * Restores in flight, by Workspace id. A Workspace's first activation both
 * reopens its remembered File windows and raises them, and the raise must
 * wait for the reopen or it finds no windows.
 */
const pendingRestores = new Map<string, Promise<void>>();

/** Reopens a Workspace's remembered File windows, tracking the call. */
export function restoreFileWindows(workspaceId: string): Promise<void> {
	const p = fileWindows.restore(workspaceId).finally(() => {
		if (pendingRestores.get(workspaceId) === p) {
			pendingRestores.delete(workspaceId);
		}
	});
	pendingRestores.set(workspaceId, p);
	return p;
}

/** Settles once no restore of this Workspace is in flight. Never rejects. */
export function afterRestore(workspaceId: string): Promise<void> {
	const p = pendingRestores.get(workspaceId);
	return p ? p.catch(() => {}) : Promise.resolve();
}

/**
 * **File window raise** (GLOSSARY.md): bring this Workspace's Markdown
 * windows up above other windows, without focusing them. Best effort — a
 * failure is logged, never thrown.
 */
export function raiseFileWindows(workspaceId: string): Promise<void> {
	const p = afterRestore(workspaceId)
		.then(() => fileWindows.raise(workspaceId))
		.catch((e) => {
			console.error("[file-window] raise failed:", e);
		});
	lastRaises.set(workspaceId, p);
	void p.then(() => {
		if (lastRaises.get(workspaceId) === p) lastRaises.delete(workspaceId);
	});
	return p;
}

/** The latest raise of each Workspace still in flight. Never rejects. */
const lastRaises = new Map<string, Promise<void>>();

/**
 * Focus one File window once any raise of its Workspace in flight is done.
 * The raise orders every sibling window to the front, so a focus that landed
 * before it could leave the picked window covered. The Navigator calls this
 * right after switching to the Workspace, whose switch starts that raise.
 * Best effort, like the raise: a window closed meanwhile is ignored.
 */
export function focusFileWindow(
	workspaceId: string,
	label: string,
): Promise<void> {
	return (lastRaises.get(workspaceId) ?? Promise.resolve())
		.then(() => fileWindows.focus(label))
		.catch(() => {});
}

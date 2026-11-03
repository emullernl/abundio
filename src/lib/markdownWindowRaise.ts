import { markdownWindows } from "./ipc";

/**
 * Restores in flight, by Workspace id. A Workspace's first activation both
 * reopens its remembered Markdown windows and raises them, and the raise must
 * wait for the reopen or it finds no windows.
 */
const pendingRestores = new Map<string, Promise<void>>();

/** Reopens a Workspace's remembered Markdown windows, tracking the call. */
export function restoreMarkdownWindows(workspaceId: string): Promise<void> {
	const p = markdownWindows.restore(workspaceId).finally(() => {
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
 * **Markdown window raise** (GLOSSARY.md): bring this Workspace's Markdown
 * windows up above other windows, without focusing them. Best effort — a
 * failure is logged, never thrown.
 */
export function raiseMarkdownWindows(workspaceId: string): Promise<void> {
	return afterRestore(workspaceId)
		.then(() => markdownWindows.raise(workspaceId))
		.catch((e) => {
			console.error("[markdown-window] raise failed:", e);
		});
}

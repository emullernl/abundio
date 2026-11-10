/**
 * **Workspace restore** (ADR-0052): each Profile remembers which Workspaces
 * were Opened and which one was Active, so it comes back as it was left.
 *
 * Writes go straight to SQLite on every change (never at quit), so a crash
 * restores too. They are fire-and-forget: a failed write is logged and must
 * never break opening or closing a Workspace.
 */
import { type WorkspaceRestoreSet, workspaces } from "./ipc";

/** Run one write, swallowing any failure, synchronous or not. */
function fire(what: string, write: () => Promise<void>): void {
	const log = (err: unknown) =>
		console.warn(`[abundio] workspace restore: ${what} failed`, err);
	try {
		Promise.resolve(write()).catch(log);
	} catch (err) {
		log(err);
	}
}

/** Put a Workspace on its Profile's restore list. */
export function rememberOpened(workspaceId: string): void {
	fire("remember opened", () => workspaces.setRestoreOpened(workspaceId, true));
}

/** Take a Workspace off its Profile's restore list (the user closed it). */
export function forgetOpened(workspaceId: string): void {
	fire("forget opened", () => workspaces.setRestoreOpened(workspaceId, false));
}

/** Remember which Workspace is Active in a Profile. */
export function rememberActive(profileId: string, workspaceId: string): void {
	fire("remember active", () =>
		workspaces.setRestoreActive(profileId, workspaceId),
	);
}

/** The Workspace to make Active after a restore: the remembered one if it
 *  came back, else the first restored one in sidebar order, else none. */
export function pickActive(set: WorkspaceRestoreSet): string | null {
	if (set.active && set.opened.includes(set.active)) return set.active;
	return set.opened[0] ?? null;
}

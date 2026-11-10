/**
 * **Workspace restore** (ADR-0052): each Profile remembers which Workspaces
 * were Opened and which one was Active, so it comes back as it was left.
 *
 * Writes go straight to SQLite on every change (never at quit), so a crash
 * restores too. They are fire-and-forget: a failed write is logged and must
 * never break opening or closing a Workspace.
 */
import { type WorkspaceRestoreSet, workspaces } from "./ipc";

/** The last write queued per row, so writes to one row land in the order
 *  they were made. The commands are `async`, so Tauri runs each invoke as
 *  its own task and two in a row can reach the database in either order — a
 *  close followed at once by a reopen could otherwise leave the Workspace
 *  Opened but off the list, with nothing to put it back. */
const lastWrite = new Map<string, Promise<void>>();

/** Run one write after the previous write to the same row, swallowing any
 *  failure, synchronous or not. */
function fire(key: string, what: string, write: () => Promise<void>): void {
	const log = (err: unknown) =>
		console.warn(`[abundio] workspace restore: ${what} failed`, err);
	const run = async () => {
		try {
			await write();
		} catch (err) {
			log(err);
		}
	};
	const next = (lastWrite.get(key) ?? Promise.resolve()).then(run);
	lastWrite.set(key, next);
	void next.then(() => {
		if (lastWrite.get(key) === next) lastWrite.delete(key);
	});
}

/** Put a Workspace on its Profile's restore list. */
export function rememberOpened(workspaceId: string): void {
	fire(`opened:${workspaceId}`, "remember opened", () =>
		workspaces.setRestoreOpened(workspaceId, true),
	);
}

/** Take a Workspace off its Profile's restore list (the user closed it). */
export function forgetOpened(workspaceId: string): void {
	fire(`opened:${workspaceId}`, "forget opened", () =>
		workspaces.setRestoreOpened(workspaceId, false),
	);
}

/** Remember which Workspace is Active in a Profile. */
export function rememberActive(profileId: string, workspaceId: string): void {
	fire(`active:${profileId}`, "remember active", () =>
		workspaces.setRestoreActive(profileId, workspaceId),
	);
}

/** The Workspace to make Active after a restore: the remembered one if it
 *  came back, else the first restored one in sidebar order, else none. */
export function pickActive(set: WorkspaceRestoreSet): string | null {
	if (set.active && set.opened.includes(set.active)) return set.active;
	return set.opened[0] ?? null;
}

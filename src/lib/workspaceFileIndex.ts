import { fs as fsApi } from "./ipc";

/**
 * Per-Workspace in-memory `Set<absolutePath>` used to answer "does this path
 * exist inside the workspace?" synchronously, on every link-provider hover.
 * Sync membership matters because xterm's `ILinkProvider` has no async resolve
 * hook — we either know an answer now or we don't show a link. The set is
 * seeded by `fs_index_workspace_files` on workspace activation and kept in
 * sync via the existing file watcher's `FsChange` events (which the watcher
 * hook routes here through `applyFsChange`).
 *
 * The set deliberately tracks the same ignore floor as `file_watcher.rs`
 * (`node_modules`, `target`, `.git`, `.DS_Store`). See ADR-0004 for why.
 */

type WorkspaceId = string;
type AbsolutePath = string;

const indexes = new Map<WorkspaceId, Set<AbsolutePath>>();
const inFlight = new Map<WorkspaceId, Promise<void>>();

/**
 * Build the index for a workspace. Safe to call repeatedly — duplicate calls
 * while a build is in flight return the same promise, and subsequent calls
 * after completion are no-ops.
 */
export function loadWorkspaceIndex(
	workspaceId: WorkspaceId,
	rootPath: string,
): Promise<void> {
	if (indexes.has(workspaceId)) return Promise.resolve();
	const existing = inFlight.get(workspaceId);
	if (existing) return existing;

	const promise = (async () => {
		try {
			const paths = await fsApi.indexWorkspaceFiles(rootPath);
			indexes.set(workspaceId, new Set(paths));
		} catch (err) {
			console.error(
				"[workspaceFileIndex] failed to build index for",
				workspaceId,
				err,
			);
			// Leave the workspace un-indexed; hover will simply return no links.
			// Caller is free to retry on the next workspace activation.
		} finally {
			inFlight.delete(workspaceId);
		}
	})();
	inFlight.set(workspaceId, promise);
	return promise;
}

/** Drop the index for a workspace (e.g. on workspace close). */
export function dropWorkspaceIndex(workspaceId: WorkspaceId): void {
	indexes.delete(workspaceId);
	inFlight.delete(workspaceId);
}

/**
 * Sync membership check. Returns `false` when the workspace has no built
 * index — callers should treat that as "no link" rather than "unknown".
 */
export function isWorkspaceFile(
	workspaceId: WorkspaceId,
	absolutePath: AbsolutePath,
): boolean {
	return indexes.get(workspaceId)?.has(absolutePath) ?? false;
}

/**
 * Apply a watcher diff: `added` go into the set, `removed` come out. Both are
 * absolute paths matching the same encoding the Rust walker emits (the
 * watcher's `changedFiles` / `removedFiles` already use absolute paths).
 *
 * Note: the watcher reports a change for any non-ignored path, so a file
 * created under a `.gitignore`d-but-not-watcher-ignored directory (e.g.
 * `dist/`) will be added here. That's the documented inconsistency in
 * ADR-0004 — the index aligns with the watcher, not with `.gitignore`.
 */
export function applyFsChange(
	workspaceId: WorkspaceId,
	added: ReadonlyArray<AbsolutePath>,
	removed: ReadonlyArray<AbsolutePath>,
): void {
	const set = indexes.get(workspaceId);
	if (!set) return;
	for (const p of added) set.add(p);
	for (const p of removed) set.delete(p);
}

/** Test-only: returns the current index size, or 0 if the workspace isn't indexed. */
export function _indexSize(workspaceId: WorkspaceId): number {
	return indexes.get(workspaceId)?.size ?? 0;
}

/** Test-only: clears all in-memory state. */
export function _resetForTests(): void {
	indexes.clear();
	inFlight.clear();
}

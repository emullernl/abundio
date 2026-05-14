import { useEffect, useRef } from "react";
import { fs as fsApi } from "../lib/ipc";
import { useExplorerStore } from "../stores/explorerStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface ActiveWatcher {
	workspaceId: string;
	unlisten: (() => void) | null;
	cancelled: boolean;
}

/**
 * Compute the set of roots that should currently be watched: the intersection
 * of workspaces with a non-empty `rootFolder` and the opened-workspace set.
 * Exported for testing.
 */
export function computeDesiredRoots(
	workspaces: ReadonlyArray<{ id: string; rootFolder: string }>,
	openedWorkspaceIds: ReadonlySet<string>,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const w of workspaces) {
		if (openedWorkspaceIds.has(w.id) && w.rootFolder) {
			out.set(w.rootFolder, w.id);
		}
	}
	return out;
}

/**
 * Decide how an `fs-change` payload should be routed into the explorer store.
 * `refreshPaths` are parent dirs whose listing must be re-fetched; `reload` is
 * whether open file panes need a content reload / conflict check. The two are
 * independent: a metadata-only touch yields `refreshPaths` but no `reload`.
 * Exported for testing.
 */
export function routeFsChange(change: {
	paths: string[];
	changedFiles: string[];
	removedFiles: string[];
}): { refreshPaths: string[]; reload: boolean } {
	return {
		refreshPaths: change.paths,
		reload: change.changedFiles.length > 0 || change.removedFiles.length > 0,
	};
}

/**
 * Given the currently-active roots and the desired roots, return which roots
 * to start watching and which to stop. Exported for testing.
 */
export function diffRoots(
	active: ReadonlySet<string>,
	desired: ReadonlyMap<string, string>,
): { toStart: string[]; toStop: string[] } {
	const toStart: string[] = [];
	const toStop: string[] = [];
	for (const root of active) {
		if (!desired.has(root)) toStop.push(root);
	}
	for (const root of desired.keys()) {
		if (!active.has(root)) toStart.push(root);
	}
	return { toStart, toStop };
}

/**
 * Owns the Rust `fs_watch_start` / `fs_watch_stop` lifecycle for every
 * currently-opened workspace, and routes `fs-change` events into the explorer
 * store: directory listings are refreshed (`refreshDirs`) and open tabs
 * auto-reload (clean tabs) or surface a conflict banner (dirty tabs).
 *
 * The watcher set is driven by `ptyActivityStore.openedWorkspaceIds`, not by
 * which workspace is visible. Switching workspaces is a no-op for this hook —
 * opened workspaces keep their watchers alive in the background, so edits
 * made elsewhere are still picked up, including their explorer-tree listings.
 * Closing or deleting a workspace stops its watcher.
 */
export function useFileReloadWatcher() {
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeRef = useRef<Map<string, ActiveWatcher>>(new Map());

	useEffect(() => {
		const active = activeRef.current;
		const desired = computeDesiredRoots(workspaces, openedWorkspaceIds);
		const { toStart, toStop } = diffRoots(new Set(active.keys()), desired);

		for (const root of toStop) {
			const entry = active.get(root);
			if (entry) {
				entry.cancelled = true;
				entry.unlisten?.();
				active.delete(root);
			}
			fsApi.watchStop(root).catch(() => {});
		}

		for (const root of toStart) {
			const workspaceId = desired.get(root);
			if (!workspaceId) continue;
			const entry: ActiveWatcher = {
				workspaceId,
				unlisten: null,
				cancelled: false,
			};
			active.set(root, entry);
			fsApi.watchStart(root).catch((err) => {
				console.error("[useFileReloadWatcher] watchStart failed:", err);
			});
			fsApi
				.onFsChange(root, (change) => {
					const { refreshPaths, reload } = routeFsChange(change);
					if (refreshPaths.length > 0) {
						useExplorerStore
							.getState()
							.refreshDirs(refreshPaths)
							.catch((err) => {
								console.error(
									"[useFileReloadWatcher] refreshDirs failed:",
									err,
								);
							});
					}
					if (!reload) return;
					useExplorerStore
						.getState()
						.handleFsChange(
							entry.workspaceId,
							change.changedFiles,
							change.removedFiles,
						)
						.catch((err) => {
							console.error(
								"[useFileReloadWatcher] handleFsChange failed:",
								err,
							);
						});
				})
				.then((unlisten) => {
					if (entry.cancelled) unlisten();
					else entry.unlisten = unlisten;
				})
				.catch((err) => {
					console.error(
						"[useFileReloadWatcher] onFsChange listen failed:",
						err,
					);
				});
		}
	}, [openedWorkspaceIds, workspaces]);

	useEffect(() => {
		const active = activeRef.current;
		return () => {
			for (const [root, entry] of active) {
				entry.cancelled = true;
				entry.unlisten?.();
				fsApi.watchStop(root).catch(() => {});
			}
			active.clear();
		};
	}, []);
}

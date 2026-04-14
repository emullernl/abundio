import { useEffect } from "react";
import { fs as fsApi } from "../lib/ipc";
import { useExplorerStore } from "../stores/explorerStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Subscribes to `fs-change` events for every workspace and routes file-level
 * changes into the explorer store so open tabs can auto-reload (clean tabs)
 * or surface a conflict banner (dirty tabs). Deletions are flagged on tabs.
 *
 * Runs for every workspace — not just the active one — so a file open in a
 * background workspace still gets reloaded when it changes on disk.
 */
export function useFileReloadWatcher() {
	const workspaceIds = useWorkspaceStore((s) =>
		s.workspaces.map((w) => `${w.id}:${w.rootFolder}`).join("|"),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-subscribe when the workspace set/roots change (tracked via the joined-string key)
	useEffect(() => {
		const workspaces = useWorkspaceStore.getState().workspaces;
		const unlisteners: Array<() => void> = [];
		let cancelled = false;

		for (const workspace of workspaces) {
			const { id, rootFolder } = workspace;
			if (!rootFolder) continue;

			// Idempotent — FileTree may already have started the watcher.
			fsApi.watchStart(rootFolder).catch(() => {});

			fsApi
				.onFsChange(rootFolder, ({ changedFiles, removedFiles }) => {
					if (changedFiles.length === 0 && removedFiles.length === 0) return;
					useExplorerStore
						.getState()
						.handleFsChange(id, changedFiles, removedFiles)
						.catch((err) => {
							console.error(
								"[useFileReloadWatcher] handleFsChange failed:",
								err,
							);
						});
				})
				.then((unlisten) => {
					if (cancelled) {
						unlisten();
					} else {
						unlisteners.push(unlisten);
					}
				})
				.catch((err) => {
					console.error(
						"[useFileReloadWatcher] onFsChange listen failed:",
						err,
					);
				});
		}

		return () => {
			cancelled = true;
			for (const u of unlisteners) u();
		};
	}, [workspaceIds]);
}

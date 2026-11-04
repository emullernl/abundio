import { useEffect } from "react";
import { restoreFileWindows } from "../lib/fileWindowRaise";
import { usePtyActivityStore } from "../stores/ptyActivityStore";

/** Ids in `next` that are not in `prev`. Exported for testing. */
export function newlyOpened(
	prev: ReadonlySet<string>,
	next: ReadonlySet<string>,
): string[] {
	return [...next].filter((id) => !prev.has(id));
}

/**
 * Reopens a Workspace's remembered **File windows** when it becomes an
 * Opened workspace in this Window — including its first activation after an
 * app restart (ADR-0046). Closing is handled where the Workspace closes
 * (`closeWorkspace`), and by Rust when this Window is destroyed.
 */
export function useFileWindowRestore(): void {
	useEffect(() => {
		let prev = usePtyActivityStore.getState().openedWorkspaceIds;
		for (const id of prev) restoreFileWindows(id).catch(() => {});
		return usePtyActivityStore.subscribe((s) => {
			const next = s.openedWorkspaceIds;
			if (next === prev) return;
			for (const id of newlyOpened(prev, next)) {
				restoreFileWindows(id).catch((e) => {
					console.error("[file-window] restore failed:", e);
				});
			}
			prev = next;
		});
	}, []);
}

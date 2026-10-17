import { useEffect } from "react";
import { markdownWindows } from "../lib/ipc";
import { usePtyActivityStore } from "../stores/ptyActivityStore";

/** Ids in `next` that are not in `prev`. Exported for testing. */
export function newlyOpened(
	prev: ReadonlySet<string>,
	next: ReadonlySet<string>,
): string[] {
	return [...next].filter((id) => !prev.has(id));
}

/**
 * Reopens a Workspace's remembered **Markdown windows** when it becomes an
 * Opened workspace in this Window — including its first activation after an
 * app restart (ADR-0046). Closing is handled where the Workspace closes
 * (`closeWorkspace`), and by Rust when this Window is destroyed.
 */
export function useMarkdownWindowRestore(): void {
	useEffect(() => {
		let prev = usePtyActivityStore.getState().openedWorkspaceIds;
		for (const id of prev) markdownWindows.restore(id).catch(() => {});
		return usePtyActivityStore.subscribe((s) => {
			const next = s.openedWorkspaceIds;
			if (next === prev) return;
			for (const id of newlyOpened(prev, next)) {
				markdownWindows.restore(id).catch((e) => {
					console.error("[markdown-window] restore failed:", e);
				});
			}
			prev = next;
		});
	}, []);
}

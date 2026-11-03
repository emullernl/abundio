import { useEffect } from "react";
import { raiseMarkdownWindows } from "../lib/markdownWindowRaise";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Raises the **Markdown windows** of each Workspace that becomes this Window's
 * Active workspace, however the switch happened (see `Markdown window raise`
 * in GLOSSARY.md). A change to no Active workspace raises nothing. Selecting
 * the already-Active Workspace again is handled in `beginWorkspaceSwitch`,
 * because it never changes `activeWorkspaceId`.
 */
export function useMarkdownWindowRaise(): void {
	useEffect(() => {
		let prev = useWorkspaceStore.getState().activeWorkspaceId;
		return useWorkspaceStore.subscribe((s) => {
			const next = s.activeWorkspaceId;
			if (next === prev) return;
			prev = next;
			if (next) void raiseMarkdownWindows(next);
		});
	}, []);
}

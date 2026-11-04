import { useEffect } from "react";
import { raiseFileWindows } from "../lib/fileWindowRaise";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Raises the **File windows** of each Workspace that becomes this Window's
 * Active workspace, however the switch happened (see `File window raise`
 * in GLOSSARY.md). A change to no Active workspace raises nothing. Selecting
 * the already-Active Workspace again is handled in `beginWorkspaceSwitch`,
 * because it never changes `activeWorkspaceId`.
 */
export function useFileWindowRaise(): void {
	useEffect(() => {
		let prev = useWorkspaceStore.getState().activeWorkspaceId;
		return useWorkspaceStore.subscribe((s) => {
			const next = s.activeWorkspaceId;
			if (next === prev) return;
			prev = next;
			if (next) void raiseFileWindows(next);
		});
	}, []);
}

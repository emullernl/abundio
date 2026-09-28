/** The text of the Left sidebar's **Remove Workspace** confirmation
 *  (`deleteWorkspace`). "Remove" is easy to read as "delete from disk", so the
 *  dialog says plainly that no files or folders are touched — only the
 *  Workspace's entry and what Abundio kept for it (#206). */
export function buildRemoveWorkspaceMessage(
	name: string,
	linkedCount: number,
): string {
	if (linkedCount > 0) {
		const worktrees = `${linkedCount} linked worktree workspace${linkedCount === 1 ? "" : "s"}`;
		return `"${name}" and its ${worktrees} will be removed from your workspace list. No files or folders are deleted: the workspace folder and the worktree folders stay on disk. Their tabs, layouts and notes in Abundio are lost. This cannot be undone.`;
	}
	return `"${name}" will be removed from your workspace list. No files or folders are deleted: the folder stays on disk. Its tabs, layout and notes in Abundio are lost. This cannot be undone.`;
}

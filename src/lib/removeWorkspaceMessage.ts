/** The text of the Left sidebar's **Remove Workspace** confirmation
 *  (`deleteWorkspace`). "Remove" is easy to read as "delete from disk", so the
 *  dialog says plainly that no files or folders are touched — only the
 *  Workspace's entry and what Abundio kept for it (#206). Environment
 *  Bundles are named because they cascade with the row (migration 013) and
 *  may hold secrets that exist nowhere else. */
export function buildRemoveWorkspaceMessage(
	name: string,
	linkedCount: number,
): string {
	if (linkedCount > 0) {
		const worktrees = `${linkedCount} linked worktree workspace${linkedCount === 1 ? "" : "s"}`;
		return `"${name}" and its ${worktrees} will be removed from your workspace list. No files or folders are deleted: the workspace folder and the worktree folders stay on disk. Their tabs, layouts, notes and environment variables in Abundio are lost. This cannot be undone.`;
	}
	return `"${name}" will be removed from your workspace list. No files or folders are deleted: the folder stays on disk. Its tabs, layout, notes and environment variables in Abundio are lost. This cannot be undone.`;
}

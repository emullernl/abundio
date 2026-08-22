/**
 * Resolve a repo-relative path (as produced by the git commands, which reject
 * absolute paths) to an absolute path under a workspace's root folder.
 *
 * `fs.readFile` / `openFile` expect absolute paths, so any git-sourced path
 * (e.g. `GitChangedFile.path`, or a diff pane's stored `filePath`) must be
 * resolved through here before it's handed to the explorer store.
 */
export function resolveWorkspacePath(
	rootFolder: string,
	relativePath: string,
): string {
	return `${rootFolder.replace(/\/$/, "")}/${relativePath}`;
}

/**
 * The inverse: an absolute path back to repo-relative, or `null` when the path
 * lies outside the workspace.
 *
 * The git commands reject absolute paths, so anything read from a pane's
 * `filePath` must come back through here before it is handed to `git.stagePath`
 * or `git.conflictFile`.
 */
export function relativeToWorkspace(
	rootFolder: string,
	absolutePath: string,
): string | null {
	const root = rootFolder.replace(/\/$/, "");
	if (!absolutePath.startsWith(`${root}/`)) return null;
	return absolutePath.slice(root.length + 1);
}

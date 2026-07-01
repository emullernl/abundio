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

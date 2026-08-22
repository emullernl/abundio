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
	return `${rootFolder.replace(/[\\/]+$/, "")}/${relativePath}`;
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
	// Normalise separators on both sides before comparing. On Windows a pane's
	// `filePath` carries backslashes (it comes from the Rust file explorer,
	// which returns native separators) while workspace roots and git paths do
	// not always agree — a raw comparison silently returns null there, which
	// would disable every conflict affordance with no error to notice.
	const root = toPosix(rootFolder).replace(/\/+$/, "");
	const path = toPosix(absolutePath);
	if (root.length === 0) return null;
	// Case-insensitive on Windows: the same drive can be spelled `C:` or `c:`.
	if (!startsWithPath(path, root)) return null;
	// `/`-separated, which is the form libgit2 and `validate_repo_relative` want.
	return path.slice(root.length + 1);
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

/** Whether `path` sits under `root`, comparing whole segments only. */
function startsWithPath(path: string, root: string): boolean {
	const prefix = `${root}/`;
	if (path.length <= prefix.length) return false;
	const head = path.slice(0, prefix.length);
	return isWindowsPath(root)
		? head.toLowerCase() === prefix.toLowerCase()
		: head === prefix;
}

function isWindowsPath(p: string): boolean {
	return /^[a-zA-Z]:\//.test(p);
}

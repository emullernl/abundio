/**
 * Keys for diff **File panes**.
 *
 * A live working-tree diff pane is keyed `diff:<path>`: one per file, whichever
 * Section opened it, and kept in sync with the disk by the file watcher.
 *
 * A **Commit diff pane** is keyed `diff@<oid>:<path>`: one per file *per
 * commit*. It shows frozen history, so it must never share a pane with the
 * live diff (which the watcher rewrites) — and because its key does not start
 * with `diff:`, every watcher and rename path that matches that prefix leaves
 * it alone without being told to. See the `Commit diff pane` entry in
 * CONTEXT.md.
 */

const COMMIT_KEY = /^diff@([0-9a-f]{7,64}):(.+)$/;

export function commitDiffKey(oid: string, path: string): string {
	return `diff@${oid}:${path}`;
}

export function parseCommitDiffKey(
	key: string,
): { oid: string; path: string } | null {
	const m = COMMIT_KEY.exec(key);
	return m ? { oid: m[1], path: m[2] } : null;
}

/** The repo-relative path behind either kind of diff key; a key that is not a
 *  diff key is returned unchanged. */
export function diffRealPath(key: string): string {
	const commit = parseCommitDiffKey(key);
	if (commit) return commit.path;
	return key.startsWith("diff:") ? key.slice("diff:".length) : key;
}

/** The title a diff pane shows: `name (diff)` for a live diff, `name @ abc1234`
 *  for a commit's. */
export function diffPaneName(key: string): string {
	const commit = parseCommitDiffKey(key);
	const name = diffRealPath(key).split("/").pop() || "file";
	return commit ? `${name} @ ${commit.oid.slice(0, 7)}` : `${name} (diff)`;
}

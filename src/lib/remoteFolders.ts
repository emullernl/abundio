import type { DirEntry } from "./types";

/** The folder above `path` (POSIX; a Host's paths), or `path` at the root. */
export function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	if (trimmed === "") return "/";
	const i = trimmed.lastIndexOf("/");
	return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** `path`'s last part, for a Workspace name. */
export function lastPart(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "/";
}

/** The entries a folder picker lists: folders (and links, which may be
 *  folders), hidden ones only when asked. */
export function pickableFolders(
	entries: DirEntry[],
	showHidden: boolean,
): DirEntry[] {
	return entries.filter(
		(e) => (e.isDir || e.isSymlink) && (showHidden || !e.name.startsWith(".")),
	);
}

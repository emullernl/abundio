/**
 * Which entries a file tree's context menu shows, as ids the tree turns into
 * menu items. Pure. A read-only tree (the **Peek explorer**) only opens,
 * reveals and copies paths: it never creates, renames or deletes.
 */

export type FileTreeMenuEntry =
	| "new-file"
	| "new-folder"
	| "reveal"
	| "reveal-folder"
	| "copy-path"
	| "rename"
	| "delete"
	| "open"
	| "open-tab"
	| "open-beside"
	| "open-below"
	| "open-window"
	| "open-diff"
	| "separator";

export interface FileTreeMenuTarget {
	/** null: the empty area under the entries (the tree's root). */
	entry: { isDir: boolean; name: string } | null;
	/** The file has a File window kind. */
	hasFileWindow: boolean;
	readOnly: boolean;
}

export function fileTreeMenu({
	entry,
	hasFileWindow,
	readOnly,
}: FileTreeMenuTarget): FileTreeMenuEntry[] {
	if (entry === null) {
		return readOnly
			? ["reveal-folder"]
			: ["new-file", "new-folder", "separator", "reveal-folder"];
	}
	if (entry.isDir) {
		return readOnly
			? ["reveal", "separator", "copy-path"]
			: [
					"new-file",
					"new-folder",
					"separator",
					"reveal",
					"separator",
					"copy-path",
					"separator",
					"rename",
					"delete",
				];
	}
	const window: FileTreeMenuEntry[] = hasFileWindow ? ["open-window"] : [];
	if (readOnly) {
		return ["open", ...window, "separator", "reveal", "separator", "copy-path"];
	}
	const diff: FileTreeMenuEntry[] = /\.(diff|patch)$/i.test(entry.name)
		? ["open-diff"]
		: [];
	return [
		"open-tab",
		"open-beside",
		"open-below",
		...window,
		...diff,
		"separator",
		"reveal",
		"separator",
		"copy-path",
		"separator",
		"rename",
		"delete",
	];
}

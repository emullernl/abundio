/**
 * The **Folder menu** of the Git changes tab — the right-click menu on a
 * **Folder row** in Tree view. See the `Folder menu` entry in GLOSSARY.md.
 *
 * Read-only, like the **Row menu**, and kept apart from it so the Row menu
 * stays a menu on one file row. Every item acts on the deepest folder the row
 * stands for. Reveal is **disabled, never dropped**, when the folder is gone
 * from disk (every file in it was deleted); the copies still work, since the
 * path is still worth pasting.
 */

import { COPY_PATH_LABELS } from "./copyPathEntries";
import type { GitRowMenuSeparator } from "./gitRowMenu";
import { revealLabel } from "./platform";

export type GitFolderMenuActionId =
	| "reveal"
	| "copy-relative-path"
	| "copy-path";

export interface GitFolderMenuAction {
	id: GitFolderMenuActionId;
	label: string;
	disabled: boolean;
}

export type GitFolderMenuEntry = GitFolderMenuAction | GitRowMenuSeparator;

export function gitFolderMenuEntries(
	existsOnDisk: boolean,
	reveal: string = revealLabel(),
): GitFolderMenuEntry[] {
	return [
		{ id: "reveal", label: reveal, disabled: !existsOnDisk },
		{ separator: true },
		{
			id: "copy-relative-path",
			label: COPY_PATH_LABELS.relative,
			disabled: false,
		},
		{ id: "copy-path", label: COPY_PATH_LABELS.absolute, disabled: false },
	];
}

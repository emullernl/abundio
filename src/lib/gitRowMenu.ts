/**
 * The **Row menu** of the Git changes tab — the right-click menu on one file
 * row. See the `Row menu` entry in CONTEXT.md.
 *
 * Deliberately **read-only**: no Stage, no Unstage, no Discard, and no item
 * that types a git command into a Pane. `Resolve & stage` stays Abundio's one
 * deliberate writer to the git index (ADR-0029), and an item that runs
 * `git restore` in a terminal would destroy work by a route that merely looks
 * read-only.
 *
 * Items that cannot apply to a row are **disabled, never dropped**, so the menu
 * keeps one shape on every row — `Copy Relative Path` never moves up two slots
 * because the file happens to be deleted.
 */

import { COPY_PATH_LABELS } from "./copyPathEntries";
import { revealLabel } from "./platform";

export type GitRowMenuActionId =
	| "open-diff"
	| "open-file"
	| "reveal"
	| "copy-relative-path"
	| "copy-path";

export interface GitRowMenuAction {
	id: GitRowMenuActionId;
	label: string;
	disabled: boolean;
}

export interface GitRowMenuSeparator {
	separator: true;
}

export type GitRowMenuEntry = GitRowMenuAction | GitRowMenuSeparator;

/** The row fields the menu's shape depends on. */
export interface GitRowMenuTarget {
	status: string;
	section: string;
	/** A binary file has no readable text diff. Only a **Commits** file row
	 *  knows this; Git changes rows leave it unset. */
	isBinary?: boolean;
}

export function gitRowMenuEntries(
	file: GitRowMenuTarget,
	reveal: string = revealLabel(),
): GitRowMenuEntry[] {
	// A deleted path has nothing on disk to open or point the file manager at.
	const isDeleted = file.status === "D";
	// An unmerged path has no stage 0, so no endpoint pair to diff — the
	// Conflicted section's rows open a text pane instead. See ADR-0029.
	const isConflicted = file.section === "conflicted";

	return [
		{
			id: "open-diff",
			label: "Open Diff",
			disabled: isConflicted || file.isBinary === true,
		},
		{ id: "open-file", label: "Open File", disabled: isDeleted },
		{ separator: true },
		{ id: "reveal", label: reveal, disabled: isDeleted },
		{ separator: true },
		{
			id: "copy-relative-path",
			label: COPY_PATH_LABELS.relative,
			disabled: false,
		},
		{ id: "copy-path", label: COPY_PATH_LABELS.absolute, disabled: false },
	];
}

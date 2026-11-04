/**
 * The **Row menu** of the Git changes tab — the right-click menu on one file
 * row, and on a file row inside an expanded **Commits** row. See the
 * `Row menu` entry in GLOSSARY.md.
 *
 * Deliberately **read-only**: no Stage, no Unstage, no Discard, and no item
 * that types a git command into a Pane. `Resolve & stage` stays Abundio's one
 * deliberate writer to the git index (ADR-0029), and an item that runs
 * `git restore` in a terminal would destroy work by a route that merely looks
 * read-only.
 *
 * Items that cannot apply because of a row's *state* are **disabled, never
 * dropped**, so the menu keeps one shape for every row of a kind — `Copy
 * Relative Path` never moves up two slots because the file happens to be
 * deleted. The file's *kind* is the one thing that changes the shape: the two
 * Separate Window items are present only on a row whose file has a **File
 * window** (text or image, by name), as in the Explorer, because on every other
 * row they would be dead items. A submodule is a kind too — on disk it is a
 * folder — so it never gets them, whatever its name.
 */

import { COPY_PATH_LABELS } from "./copyPathEntries";
import { fileWindowKindFor } from "./fileWindowKind";
import { revealLabel } from "./platform";

export type GitRowMenuActionId =
	| "open-diff"
	| "open-file"
	| "open-diff-window"
	| "open-file-window"
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
	/** Repo-relative path. Only its extension matters here: it decides whether
	 *  the row's file has a File window. */
	path: string;
	status: string;
	section: string;
	/** A binary file has no readable text diff. Only a **Commits** file row
	 *  knows this; Git changes rows leave it unset. */
	isBinary?: boolean;
	/** A submodule pointer: no text to diff, and on disk it is a folder that
	 *  a file pane cannot open. Also only known to a **Commits** file row. */
	isSubmodule?: boolean;
}

export function gitRowMenuEntries(
	file: GitRowMenuTarget,
	reveal: string = revealLabel(),
): GitRowMenuEntry[] {
	// A deleted path has nothing on disk to open or point the file manager at.
	const isDeleted = file.status === "D";
	const isSubmodule = file.isSubmodule === true;
	// An unmerged path has no stage 0, so no endpoint pair to diff — the
	// Conflicted section's rows open a text pane instead. See ADR-0029.
	const isConflicted = file.section === "conflicted";

	const openDiffDisabled =
		isConflicted || file.isBinary === true || isSubmodule;
	const openFileDisabled = isDeleted || isSubmodule;

	// Each follows its in-pane twin, state rules included. The diff item opens
	// the row's live diff, or on a Commits row that commit's diff; the file
	// item opens the file as it is on disk now — on a Commits row too, never as
	// that commit left it — and is enabled on a conflicted row, markers and
	// all, as Open File is. Left out rather than disabled on a submodule or a
	// file with no File window: that is its kind, not its state.
	const windowEntries: GitRowMenuEntry[] =
		fileWindowKindFor(file.path) && !isSubmodule
			? [
					{
						id: "open-diff-window",
						label: "Open Diff in Separate Window",
						disabled: openDiffDisabled,
					},
					{
						id: "open-file-window",
						label: "Open File in Separate Window",
						disabled: openFileDisabled,
					},
				]
			: [];

	return [
		{
			id: "open-diff",
			label: "Open Diff",
			disabled: openDiffDisabled,
		},
		{ id: "open-file", label: "Open File", disabled: openFileDisabled },
		...windowEntries,
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

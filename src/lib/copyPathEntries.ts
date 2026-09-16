import { relativeToWorkspace } from "./resolveWorkspacePath";

/**
 * The two path-copy items shared by the **Explorer tab**'s context menu and the
 * Git changes tab's **Row menu**.
 *
 * Relative comes first: it is what you paste into a terminal already sitting in
 * the workspace, or into a message to an Agent — the dominant case in a
 * terminal multiplexer. The absolute form is the one that travels to other
 * apps.
 *
 * A path outside the workspace root has no relative form, so that entry carries
 * `text: null` and is rendered **disabled rather than dropped** — the menu keeps
 * one shape either way.
 */
export const COPY_PATH_LABELS = {
	relative: "Copy Relative Path",
	absolute: "Copy Path",
} as const;

export interface CopyPathEntry {
	id: "copy-relative-path" | "copy-path";
	label: string;
	/** What lands on the clipboard, or null when there is nothing honest to put
	 *  there. */
	text: string | null;
}

export function copyPathEntries(
	rootFolder: string,
	absolutePath: string,
): CopyPathEntry[] {
	return [
		{
			id: "copy-relative-path",
			label: COPY_PATH_LABELS.relative,
			text: relativeToWorkspace(rootFolder, absolutePath),
		},
		{ id: "copy-path", label: COPY_PATH_LABELS.absolute, text: absolutePath },
	];
}

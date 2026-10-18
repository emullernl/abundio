/** Paths of the unsaved File panes in a Window, sorted and without repeats
 *  (two panes can show the same file), for the quit confirmation. */
export function unsavedFilePaths(
	filePanes: Readonly<Record<string, { filePath: string; isDirty: boolean }>>,
): string[] {
	const paths = new Set<string>();
	for (const pane of Object.values(filePanes)) {
		if (pane.isDirty) paths.add(pane.filePath);
	}
	return [...paths].sort();
}

import type { SearchFileResult, SearchMatch } from "./types";

/**
 * Uniform height (px) of every rendered search row — both file headers and
 * match lines. A single fixed height lets the panel virtualize with plain
 * arithmetic (no per-row measurement): row `i` sits at `i * SEARCH_ROW_HEIGHT`.
 */
export const SEARCH_ROW_HEIGHT = 22;

export type SearchRow =
	| { kind: "file"; key: string; file: SearchFileResult }
	| { kind: "match"; key: string; filePath: string; match: SearchMatch };

/**
 * Flatten the grouped `files` (each with its matches) into a single linear list
 * of rows, honoring per-file collapse state. This flat list is what the
 * virtualized panel slices by index — collapsed files contribute only their
 * header row, so a giant file no longer forces thousands of rows into the DOM.
 */
export function flattenSearchRows(
	files: SearchFileResult[],
	collapsedFiles: Record<string, boolean>,
): SearchRow[] {
	const rows: SearchRow[] = [];
	for (const file of files) {
		rows.push({ kind: "file", key: `f:${file.filePath}`, file });
		if (collapsedFiles[file.filePath]) continue;
		for (const match of file.matches) {
			rows.push({
				kind: "match",
				key: `m:${file.filePath}:${match.lineNumber}:${match.matchStart}:${match.matchEnd}`,
				filePath: file.filePath,
				match,
			});
		}
	}
	return rows;
}

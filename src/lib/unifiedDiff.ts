export interface ParsedUnifiedDiff {
	original: string;
	modified: string;
}

const HUNK_HEADER = /^@@ .* @@/;

/**
 * Reconstruct the two file sides represented by a unified diff.
 * File headers and hunk metadata are intentionally omitted from the editor.
 */
export function parseUnifiedDiff(source: string): ParsedUnifiedDiff {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	let inHunk = false;

	for (const line of source.split(/\r?\n/)) {
		if (HUNK_HEADER.test(line)) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;

		if (line.startsWith(" ")) {
			const content = line.slice(1);
			oldLines.push(content);
			newLines.push(content);
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			oldLines.push(line.slice(1));
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			newLines.push(line.slice(1));
		}
	}

	// Keep an unrecognised patch readable instead of showing an empty editor.
	if (!inHunk) return { original: "", modified: source };

	return {
		original: oldLines.join("\n"),
		modified: newLines.join("\n"),
	};
}

export function isUnifiedDiffFile(filePath: string, content: string): boolean {
	if (!/\.(diff|patch)$/i.test(filePath)) return false;
	return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(content);
}

export interface ParsedUnifiedDiff {
	original: string;
	modified: string;
	/** Path from the first file header, used for syntax highlighting. */
	languagePath: string | null;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;

function countOrOne(value: string | undefined): number {
	return value === undefined ? 1 : Number(value);
}

/**
 * Reconstruct the file sides represented by a unified diff.
 * Hunk line counts, rather than content prefixes, determine which lines belong
 * to each side so content such as "---" and "+++" remains intact.
 */
export function parseUnifiedDiff(source: string): ParsedUnifiedDiff {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	const lines = source.split(/\r?\n/);
	let oldRemaining = 0;
	let newRemaining = 0;
	let sawHunk = false;
	let languagePath: string | null = null;
	let currentPath: string | null = null;
	let fileCount = 0;

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (fileCount > 0) {
				oldLines.push(`=== ${currentPath ?? "next file"} ===`);
				newLines.push(`=== ${currentPath ?? "next file"} ===`);
			}
			fileCount += 1;
			currentPath = null;
			continue;
		}

		if (line.startsWith("+++ ")) {
			const path = line.slice(4);
			if (path !== "/dev/null") {
				currentPath = path.replace(/^b\//, "");
				languagePath ??= currentPath;
			}
			continue;
		}
		if (line.startsWith("--- ")) {
			const path = line.slice(4);
			if (path !== "/dev/null") {
				const oldPath = path.replace(/^a\//, "");
				currentPath ??= oldPath;
				languagePath ??= oldPath;
			}
			continue;
		}

		const hunk = line.match(HUNK_HEADER);
		if (hunk) {
			oldRemaining = countOrOne(hunk[1]);
			newRemaining = countOrOne(hunk[2]);
			sawHunk = true;
			continue;
		}

		if (!sawHunk || (oldRemaining === 0 && newRemaining === 0)) continue;
		if (line === "\\ No newline at end of file") continue;

		const marker = line[0];
		const content = line.slice(1);
		if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
			oldLines.push(content);
			newLines.push(content);
			oldRemaining -= 1;
			newRemaining -= 1;
		} else if (marker === "-" && oldRemaining > 0) {
			oldLines.push(content);
			oldRemaining -= 1;
		} else if (marker === "+" && newRemaining > 0) {
			newLines.push(content);
			newRemaining -= 1;
		}
	}

	if (!sawHunk) {
		return { original: "", modified: source, languagePath };
	}

	return {
		original: oldLines.join("\n"),
		modified: newLines.join("\n"),
		languagePath,
	};
}

export function isUnifiedDiffFile(filePath: string, content: string): boolean {
	if (!/\.(diff|patch)$/i.test(filePath)) return false;
	return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(content);
}

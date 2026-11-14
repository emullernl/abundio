import { git as gitApi } from "./ipc";
import type { GitChangedFile } from "./types";

/**
 * A file's uncommitted changes, for something that only knows the file:
 * unstaged first, then staged, then a new file's whole content; the first
 * section where it actually differs (else the first that answered). `null`
 * when git knows nothing of it.
 */
export async function liveDiff(
	cwd: string,
	rel: string,
): Promise<{
	original: string;
	modified: string;
	section: GitChangedFile["section"];
} | null> {
	let fallback: Awaited<ReturnType<typeof liveDiff>> = null;
	for (const section of ["unstaged", "staged", "untracked"] as const) {
		try {
			const d = await gitApi.fileDiff(cwd, rel, section);
			const found = { original: d.original, modified: d.modified, section };
			if (d.original !== d.modified) return found;
			fallback ??= found;
		} catch {
			// Not in this section.
		}
	}
	return fallback;
}

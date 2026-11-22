/**
 * Menu entries that only work on this computer (phase 10f): "Reveal in
 * Finder" opens this computer's file manager, which cannot show a Host's
 * file. A Host's Workspace leaves them out. Pure.
 */

const REVEAL_IDS = new Set(["reveal", "reveal-folder"]);

function idOf(e: unknown): string | null {
	if (typeof e === "string") return e;
	if (e && typeof e === "object" && "id" in e) return String(e.id);
	return null;
}

function isSeparator(e: unknown): boolean {
	return (
		e === "separator" || (!!e && typeof e === "object" && "separator" in e)
	);
}

/** `entries` without the this-computer-only ones when `remote`, and without
 *  the separators left at an end or next to another. */
export function withoutLocalOnly<T>(entries: T[], remote: boolean): T[] {
	if (!remote) return entries;
	const kept = entries.filter((e) => !REVEAL_IDS.has(idOf(e) ?? ""));
	const out: T[] = [];
	for (const e of kept) {
		if (
			isSeparator(e) &&
			(out.length === 0 || isSeparator(out[out.length - 1]))
		)
			continue;
		out.push(e);
	}
	while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop();
	return out;
}

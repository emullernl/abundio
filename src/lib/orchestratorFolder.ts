/**
 * The **Orchestrator folder** (ADR-0059) on the frontend: how Settings shows
 * its path, and what a Profile window does when it changes.
 */

/** `path` with the home folder written as `~`, as a person reads it. Pure. */
export function tildePath(path: string, home: string): string {
	const h = home.replace(/[\\/]+$/, "");
	if (!h) return path;
	if (path === h) return "~";
	for (const sep of ["/", "\\"]) {
		if (path.startsWith(h + sep)) return `~${sep}${path.slice(h.length + 1)}`;
	}
	return path;
}

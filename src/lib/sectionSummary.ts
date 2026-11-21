import type { Rollups } from "../stores/ptyActivityStore";

/**
 * A Workspace list section's one line (docs/plans/remote-hosts.md phase 10):
 * how many Workspaces it has, then its Agents by status, most urgent first,
 * leaving out what is zero: "3 workspaces · 1 waiting · 2 working".
 */
export function sectionSummary(count: number, rollups: Rollups | undefined): string {
	const parts = [count === 1 ? "1 workspace" : `${count} workspaces`];
	const c = rollups?.agent?.counts;
	if (c) {
		for (const [n, label] of [
			[c.error, "error"],
			[c.waiting, "waiting"],
			[c.ready, "ready"],
			[c.working, "working"],
		] as const) {
			if (n > 0) parts.push(`${n} ${label}`);
		}
	}
	return parts.join(" · ");
}

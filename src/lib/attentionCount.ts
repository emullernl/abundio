import type { PtyActivityEntry } from "../stores/ptyActivityStore";

/** This Window's share of the **Attention count**: PTYs that are Waiting,
 *  Ready or Error, agent or shell alike, plus `alsoWanting` (PTYs of panes
 *  with an **Attention flag**, ADR-0056). Each
 *  PTY counts once. Both kinds of Error count (a Turn failure and a Mid-turn
 *  failure), because both show the red status icon. Rust sums every Window's
 *  share for the **App icon badge**. */
export function attentionCount(
	activities: Record<string, PtyActivityEntry>,
	alsoWanting: Iterable<string> = [],
): number {
	const wanting = new Set<string>();
	for (const [ptyId, entry] of Object.entries(activities)) {
		if (
			entry.state === "waiting" ||
			entry.state === "ready" ||
			entry.state === "error"
		) {
			wanting.add(ptyId);
		}
	}
	for (const ptyId of alsoWanting) if (ptyId) wanting.add(ptyId);
	return wanting.size;
}

/** Reports this Window's share of the Attention count, sending only when the
 *  number changes. A disabled badge reports 0. Call the returned function on
 *  start and whenever PTY status or settings change. */
export function createAttentionReporter(
	getEnabled: () => boolean,
	getActivities: () => Record<string, PtyActivityEntry>,
	send: (count: number) => void,
	getAlsoWanting: () => Iterable<string> = () => [],
): () => void {
	let last = -1;
	return () => {
		const count = getEnabled()
			? attentionCount(getActivities(), getAlsoWanting())
			: 0;
		if (count === last) return;
		last = count;
		send(count);
	};
}

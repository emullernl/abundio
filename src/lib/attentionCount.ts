import type { PtyActivityEntry } from "../stores/ptyActivityStore";

/** This Window's share of the **Attention count**: PTYs that are Waiting,
 *  Ready or Error, agent or shell alike. Both kinds of Error count (a Turn
 *  failure and a Mid-turn failure), because both show the red status icon.
 *  Rust sums every Window's share for the **App icon badge**. */
export function attentionCount(
	activities: Record<string, PtyActivityEntry>,
): number {
	let n = 0;
	for (const entry of Object.values(activities)) {
		if (
			entry.state === "waiting" ||
			entry.state === "ready" ||
			entry.state === "error"
		) {
			n++;
		}
	}
	return n;
}

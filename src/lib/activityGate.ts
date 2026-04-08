/** Number of byte-threshold crossings required within ACTIVITY_HIT_WINDOW_MS
 *  before agent-mode activity detection fires. */
export const ACTIVITY_HIT_COUNT = 7;

/** Sliding window in which ACTIVITY_HIT_COUNT crossings must occur. */
export const ACTIVITY_HIT_WINDOW_MS = 10_000;

/** Record a new threshold crossing into a sliding window of recent crossings.
 *
 *  Returns the pruned hit list and a `fire` flag that is true when the count
 *  reaches `required`. When `fire` is true the caller should treat this as an
 *  activity event and reset the hit list (the returned `hitTimes` is already
 *  empty in that case).
 */
export function recordThresholdHit(
	hitTimes: number[],
	now: number,
	windowMs: number = ACTIVITY_HIT_WINDOW_MS,
	required: number = ACTIVITY_HIT_COUNT,
): { hitTimes: number[]; fire: boolean } {
	const cutoff = now - windowMs;
	const pruned = hitTimes.filter((t) => t >= cutoff);
	pruned.push(now);
	if (pruned.length >= required) {
		return { hitTimes: [], fire: true };
	}
	return { hitTimes: pruned, fire: false };
}

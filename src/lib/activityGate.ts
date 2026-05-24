/** Number of byte-threshold crossings required within ACTIVITY_HIT_WINDOW_MS
 *  before agent-mode activity detection fires. */
export const ACTIVITY_HIT_COUNT = 5;

/** Sliding window in which ACTIVITY_HIT_COUNT crossings must occur. */
export const ACTIVITY_HIT_WINDOW_MS = 5_000;

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

/** Shell exit codes produced by a user-initiated stop — Ctrl+C (128 + SIGINT)
 *  and SIGTERM (128 + SIGTERM). These are deliberate, not failures. */
export const SHELL_USER_STOP_CODES = [130, 143];

/** Classify a finished shell command (or an exited shell-mode PTY) into the
 *  status transition it should drive.
 *
 *  `"error"` is returned regardless of `showActivity` — a failed command
 *  always turns the dot red. `"success"` (a clean finish) is only surfaced
 *  when terminal activity status is enabled; otherwise `"none"` keeps the dot
 *  neutral. A user-initiated stop (Ctrl+C → 130, SIGTERM → 143) counts as a
 *  clean finish, not an error.
 */
export function classifyShellExit(
	exitCode: number | null | undefined,
	showActivity: boolean,
): "error" | "success" | "none" {
	const isFailure =
		typeof exitCode === "number" &&
		exitCode !== 0 &&
		!SHELL_USER_STOP_CODES.includes(exitCode);
	if (isFailure) return "error";
	return showActivity ? "success" : "none";
}

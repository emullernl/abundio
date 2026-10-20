/**
 * User Timing marks for profiling Workspace and tab switches.
 *
 * They show up in the Safari Web Inspector Timelines (attach it to the Tauri
 * webview) and in Chrome's Performance panel (`pnpm demo:web`), lined up with
 * the layout, paint and WebGL work around them. Cheap enough to leave on.
 *
 * Every call is guarded: a missing or partial `performance` (older WebKit,
 * jsdom) must never break a switch for the sake of a measurement.
 */

/** Mark a moment, e.g. the store update that starts a switch. */
export function perfMark(name: string): void {
	try {
		performance.mark(name);
	} catch {
		// Profiling only.
	}
}

/** Record a span that started at `start` (a `performance.now()` value) and
 *  ends now. `detail` names what was measured, e.g. a pane id. */
export function perfMeasure(
	name: string,
	start: number,
	detail?: string,
): void {
	try {
		performance.measure(name, { start, end: performance.now(), detail });
	} catch {
		// Profiling only.
	}
}

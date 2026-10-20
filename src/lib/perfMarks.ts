/**
 * User Timing marks for profiling Workspace and tab switches.
 *
 * They show up in the Safari Web Inspector Timelines (attach it to the Tauri
 * webview) and in Chrome's Performance panel (`pnpm demo:web`), lined up with
 * the layout, paint and WebGL work around them. Cheap enough to leave on:
 * each entry is cleared as soon as it is recorded, so the page's timing buffer
 * never grows. A timeline recording captures entries as they are made, so it
 * still shows them; only `performance.getEntries*` comes back empty.
 *
 * Every call is guarded: a missing or partial `performance` (older WebKit,
 * jsdom) must never break a switch for the sake of a measurement.
 */

/** Mark a moment, e.g. the store update that starts a switch. */
export function perfMark(name: string): void {
	try {
		performance.mark(name);
		performance.clearMarks(name);
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
		performance.clearMeasures(name);
	} catch {
		// Profiling only.
	}
}

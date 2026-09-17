import type { ITheme } from "@xterm/xterm";

/**
 * The one-way door between `settingsStore` and `terminalManager`.
 *
 * `terminalManager` imports the settings store, and the store used to import
 * `terminalManager`'s setters straight back. That cycle is not merely untidy —
 * it is a live bug. The app's module graph enters `terminalManager` first, so
 * `settingsStore`'s body (and with it `persist`'s synchronous hydration) runs
 * *during* `terminalManager`'s import phase, before a single statement of its
 * body. Every top-level `let`/`const` in that module is still in the temporal
 * dead zone at that moment, so calling any setter throws
 * `Cannot access ... before initialization`. Zustand catches the throw inside
 * its own promise chain and drops it, and the rest of the rehydrate handler
 * never runs: the mouse-reporting master switch stays at its default of ON
 * however the setting is stored, GPU acceleration ignores a disabled setting,
 * and Rust never hears the update-check or PR-poller config.
 *
 * Deferring the flush with a timer looks like a fix and is not: under a module
 * runner that awaits each dependency, no timer lands after the body either.
 * The only timing-independent answer is a signal, which is what this module is.
 * It imports nothing at runtime, so it is fully initialised before either side
 * of the old cycle begins, and the store's pushes simply wait until
 * `terminalManager` says it exists.
 */
export interface TerminalSettings {
	/** Fire-and-forget: the real implementation is `async` (it awaits
	 *  `document.fonts.load` before touching any pane), so unlike every other
	 *  setter here this one returns before it has finished. See the ordering
	 *  caveat on `withTerminalSettings`. */
	setAllTerminalsFontFamily(fontFamily: string): void;
	setAllTerminalsFontSize(fontSize: number): void;
	setAllTerminalsScrollback(scrollback: number): void;
	setAllTerminalsTheme(theme: ITheme): void;
	setActivityByteThreshold(n: number): void;
	setWebglEnabled(enabled: boolean): void;
	setMouseReportingBlocked(blocked: boolean): void;
}

let terminals: TerminalSettings | null = null;
const queued: ((t: TerminalSettings) => void)[] = [];

/** Called once by `terminalManager`, at the very bottom of its module body —
 *  the first point at which every binding its setters touch exists. */
export function registerTerminalSettings(impl: TerminalSettings): void {
	terminals = impl;
	const pending = queued.splice(0, queued.length);
	for (const fn of pending) fn(impl);
}

/**
 * Run `fn` against the terminal setters, now or as soon as they exist.
 *
 * Queued calls are *invoked* in the order they were made, so a rehydrate that
 * pushes font, theme and scrollback reaches the setters in the order the
 * handler wrote them. Their *effects* land in that order too, with one
 * exception: `setAllTerminalsFontFamily` is async under the hood and applies
 * after its font load resolves, so a theme or scrollback push made after it
 * will touch the panes first. Nothing depends on that today — they write
 * disjoint xterm options — but do not build an ordering guarantee on it.
 *
 * After registration this is a plain synchronous call, which is what every
 * settings *action* gets, since those only ever fire long after startup.
 */
export function withTerminalSettings(
	fn: (terminals: TerminalSettings) => void,
): void {
	if (terminals) {
		fn(terminals);
		return;
	}
	queued.push(fn);
	warnIfNobodyRegisters();
}

/**
 * Dev-only tripwire for the one way this module can fail silently.
 *
 * Queueing is only ever correct because `terminalManager` is guaranteed to be
 * evaluated — every window's entry point pulls it in through a static import,
 * which is hoisted regardless of the `IS_SETTINGS_WINDOW` branching below it in
 * `main.tsx`. That is a thin thread: delete the last such import in a tidy-up
 * and every push here becomes a permanent no-op, with the queue growing one
 * closure per cross-Window rehydrate — exactly the silent failure this module
 * exists to kill, wearing a different hat.
 *
 * One warning per session, on a macrotask so it fires after the module graph
 * has finished evaluating.
 */
let registrationWatchdogArmed = false;
function warnIfNobodyRegisters(): void {
	if (!import.meta.env.DEV || registrationWatchdogArmed) return;
	registrationWatchdogArmed = true;
	setTimeout(() => {
		if (terminals) return;
		console.error(
			`[terminalSettingsBridge] nothing registered terminal setters; ${queued.length} settings push(es) are stranded. ` +
				"Does this window's entry point still import lib/terminalManager?",
		);
	}, 0);
}

/** Test-only: drop the registration and any queued calls. */
export function resetTerminalSettingsForTest(): void {
	terminals = null;
	queued.length = 0;
	registrationWatchdogArmed = false;
}

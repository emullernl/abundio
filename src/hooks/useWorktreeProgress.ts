import { useEffect, useRef, useState } from "react";

export type WorktreeVerb = "Creating" | "Removing";

export interface WorktreeProgressDisplay {
	verb: WorktreeVerb;
	target: string;
	status: "progress" | "error";
	error?: string;
}

interface RunOptions {
	verb: WorktreeVerb;
	/** Identifier shown in the message, e.g. a branch or a quoted name. */
	target: string;
	/** Don't show the modal unless the op is still running after this long. */
	showDelayMs?: number;
	/** Once shown, keep it up at least this long so it never flickers. */
	minHoldMs?: number;
}

export interface RunResult {
	ok: boolean;
	error?: string;
}

export interface WorktreeProgressController {
	run: (opts: RunOptions, task: () => Promise<unknown>) => Promise<RunResult>;
	/** Clear the current display (the error state's Close button). */
	dismiss: () => void;
	/** Cancel pending timers — used on host unmount. */
	clear: () => void;
}

/**
 * Pure (React-free) state machine behind the worktree waiting modal. A `run`:
 *  - shows the progress display only if the op is still running after
 *    `showDelayMs` (a fast/small repo never flashes one),
 *  - keeps it up at least `minHoldMs` once shown so it can't flicker, and
 *  - on failure flips to an error display *immediately*, bypassing the delay —
 *    errors are never hidden behind a timer. The error display persists until
 *    `dismiss`.
 *
 * Timer-based (no wall-clock reads) so it's deterministic under fake timers.
 * The operation itself isn't cancelable (libgit2 runs synchronously inside
 * spawn_blocking); this only governs the indicator.
 */
export function createWorktreeProgress(
	setDisplay: (display: WorktreeProgressDisplay | null) => void,
): WorktreeProgressController {
	let timers: ReturnType<typeof setTimeout>[] = [];
	// Monotonic token identifying the live run. abort() and a new run() bump it,
	// so a still-pending task from a superseded run becomes a no-op when it
	// finally settles — no late display flash, no dangling run promise.
	let token = 0;
	// Resolver of the in-flight run's promise, so abort() can settle it.
	let activeResolve: ((result: RunResult) => void) | null = null;

	const clearTimers = () => {
		for (const t of timers) clearTimeout(t);
		timers = [];
	};

	// Cancel the live run: stop its timers, invalidate it, and settle its promise
	// (so dismiss()/clear() mid-run never leaves it dangling forever).
	const abort = (result: RunResult) => {
		clearTimers();
		token++;
		if (activeResolve) {
			const resolve = activeResolve;
			activeResolve = null;
			resolve(result);
		}
	};

	const run = (
		opts: RunOptions,
		task: () => Promise<unknown>,
	): Promise<RunResult> => {
		const { verb, target, showDelayMs = 150, minHoldMs = 400 } = opts;
		// Supersede any prior run cleanly before starting this one.
		abort({ ok: false });
		const myToken = token;
		let shown = false;
		let minHoldDone = false;
		let succeeded = false;

		return new Promise<RunResult>((resolve) => {
			activeResolve = resolve;
			// Settle this run's promise once; idempotent vs. a prior abort().
			const settle = (result: RunResult) => {
				if (activeResolve === resolve) activeResolve = null;
				resolve(result);
			};
			// True once this run has been superseded/aborted.
			const stale = () => myToken !== token;
			const hide = () => {
				clearTimers();
				setDisplay(null);
				settle({ ok: true });
			};

			const showTimer = setTimeout(() => {
				if (stale()) return;
				shown = true;
				setDisplay({ verb, target, status: "progress" });
				const holdTimer = setTimeout(() => {
					minHoldDone = true;
					if (succeeded) hide();
				}, minHoldMs);
				timers.push(holdTimer);
			}, showDelayMs);
			timers.push(showTimer);

			// `Promise.resolve().then(task)` so a *synchronous* throw from task()
			// is routed to the rejection handler (and the error display) rather
			// than rejecting the outer run promise with the raw error.
			Promise.resolve()
				.then(task)
				.then(
					() => {
						if (stale()) return settle({ ok: false });
						succeeded = true;
						if (!shown) {
							// Finished before the modal ever appeared — show nothing.
							clearTimers();
							setDisplay(null);
							settle({ ok: true });
						} else if (minHoldDone) {
							hide();
						}
						// else: the hold timer will hide it once the minimum elapses.
					},
					(err: unknown) => {
						if (stale()) return settle({ ok: false });
						clearTimers();
						const error = err instanceof Error ? err.message : String(err);
						setDisplay({ verb, target, status: "error", error });
						settle({ ok: false, error });
					},
				);
		});
	};

	const dismiss = () => {
		abort({ ok: false });
		setDisplay(null);
	};

	// Cancel timers and settle the in-flight run (used on host unmount); leaves
	// the current display as-is since the host is going away anyway.
	const clear = () => abort({ ok: false });

	return { run, dismiss, clear };
}

/** React binding for {@link createWorktreeProgress}. `run`/`dismiss` are stable. */
export function useWorktreeProgress() {
	const [display, setDisplay] = useState<WorktreeProgressDisplay | null>(null);
	const ref = useRef<WorktreeProgressController | null>(null);
	if (ref.current === null) ref.current = createWorktreeProgress(setDisplay);

	// Drop any pending timers if the host unmounts mid-operation.
	useEffect(() => () => ref.current?.clear(), []);

	return { display, run: ref.current.run, dismiss: ref.current.dismiss };
}

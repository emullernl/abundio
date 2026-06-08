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
	const clear = () => {
		for (const t of timers) clearTimeout(t);
		timers = [];
	};

	const run = (
		opts: RunOptions,
		task: () => Promise<unknown>,
	): Promise<RunResult> => {
		const { verb, target, showDelayMs = 150, minHoldMs = 400 } = opts;
		clear();
		let shown = false;
		let minHoldDone = false;
		let succeeded = false;

		return new Promise<RunResult>((resolve) => {
			const hide = () => {
				clear();
				setDisplay(null);
				resolve({ ok: true });
			};

			const showTimer = setTimeout(() => {
				shown = true;
				setDisplay({ verb, target, status: "progress" });
				const holdTimer = setTimeout(() => {
					minHoldDone = true;
					if (succeeded) hide();
				}, minHoldMs);
				timers.push(holdTimer);
			}, showDelayMs);
			timers.push(showTimer);

			task().then(
				() => {
					succeeded = true;
					if (!shown) {
						// Finished before the modal ever appeared — show nothing.
						clear();
						setDisplay(null);
						resolve({ ok: true });
					} else if (minHoldDone) {
						hide();
					}
					// else: the hold timer will hide it once the minimum elapses.
				},
				(err: unknown) => {
					clear();
					const error = err instanceof Error ? err.message : String(err);
					setDisplay({ verb, target, status: "error", error });
					resolve({ ok: false, error });
				},
			);
		});
	};

	const dismiss = () => {
		clear();
		setDisplay(null);
	};

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

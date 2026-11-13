// A new pane's PTY normally starts when its terminal is first shown, at the
// size it is shown at (`ensurePtySpawned` from `projectInto`). A pane that
// Agent control opens in a Tab or Workspace nobody is looking at is never
// shown, so without this it would not start until the user went there.
// `startUnlessShown` gives it a moment to be shown, then starts it hidden.
// Showing it later resizes the PTY like any switch back to a pane.

/** How long a new pane may take to be shown before its PTY starts hidden. */
export const HIDDEN_SPAWN_DELAY_MS = 500;
/** Stop waiting for the pane's terminal after this long. */
export const HIDDEN_SPAWN_LIMIT_MS = 30_000;

export interface HiddenSpawnDeps {
	/** The pane's terminal exists (its PTY may or may not have started). */
	exists: () => boolean;
	/** Its PTY has started, or is starting. */
	started: () => boolean;
	/** Start it now, hidden. */
	start: () => void;
	/** Call `listener` whenever the pane's terminal changes. */
	subscribe: (listener: () => void) => () => void;
}

/**
 * Once the pane's terminal exists, wait `HIDDEN_SPAWN_DELAY_MS`; if its PTY
 * has still not started (nothing showed it), start it. Gives up after
 * `HIDDEN_SPAWN_LIMIT_MS`. Returns a cancel.
 */
export function startUnlessShown(deps: HiddenSpawnDeps): () => void {
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: () => void = () => {};
	const stop = () => {
		done = true;
		clearTimeout(timer);
		clearTimeout(giveUp);
		unsubscribe();
	};
	const arm = () => {
		if (done || timer !== undefined || !deps.exists()) return;
		timer = setTimeout(() => {
			if (deps.exists() && !deps.started()) deps.start();
			stop();
		}, HIDDEN_SPAWN_DELAY_MS);
	};
	const giveUp = setTimeout(stop, HIDDEN_SPAWN_LIMIT_MS);
	unsubscribe = deps.subscribe(arm);
	arm();
	return stop;
}

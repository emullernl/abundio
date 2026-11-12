// When a split by Agent control leaves the caller's Tab crowded, its reply
// suggests a new Tab next time (`--tab`). The split itself still happens:
// the hint informs, it never decides. See docs/plans/agent-control.md step 14.

import type { Direction } from "./types";

/** Narrower than this, a pane is cramped for an Agent's TUI. */
export const MIN_COLS = 60;
/** Shorter than this, likewise. */
export const MIN_ROWS = 12;
/** A Tab already holding this many terminal panes is busy whatever its size. */
export const MAX_PANES = 4;

/**
 * The hint for a split of a `cols` × `rows` pane in `direction`, in a Tab
 * holding `terminalPanes` terminal panes before the split; null when the Tab
 * is not crowded. The halves are what the split makes: half the columns for
 * `right`, half the rows for `down` (one cell goes to the divider).
 */
export function crowdHint({
	terminalPanes,
	cols,
	rows,
	direction,
}: {
	terminalPanes: number;
	cols: number;
	rows: number;
	direction: Direction;
}): string | null {
	const halfCols = direction === "right" ? Math.floor((cols - 1) / 2) : cols;
	const halfRows = direction === "down" ? Math.floor((rows - 1) / 2) : rows;
	const small = halfCols < MIN_COLS || halfRows < MIN_ROWS;
	const busy = terminalPanes >= MAX_PANES;
	if (!small && !busy) return null;
	const why = busy
		? `this Tab already had ${terminalPanes} panes`
		: `the new panes are only ${halfCols} columns × ${halfRows} rows`;
	return `${why}; next time, start helpers in a Tab of their own with --tab`;
}

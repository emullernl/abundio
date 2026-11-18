/**
 * Geometry of the **Orchestrator view** (ADR-0057), shared by the view (which
 * draws the Orchestrator tabs on top) and `App.tsx` (which draws the
 * Orchestrator workspace's own Tab bar and panes below, in the ordinary
 * Workspace stack). Pure.
 */

/** Height of the Orchestrator tab strip. */
export const ORCHESTRATOR_TAB_STRIP = 34;
/** Height of the divider between the top area and the panes. */
export const ORCHESTRATOR_DIVIDER = 6;
/** The panes always keep at least this much height. */
export const ORCHESTRATOR_PANES_MIN = 160;

/**
 * Height of the top area's content: `ratio` of what is left under the tab
 * strip and the divider, clamped so the panes below keep
 * `ORCHESTRATOR_PANES_MIN`. `viewHeight` is the whole view's height; 0 (not
 * measured yet) gives 0.
 */
export function topContentHeight(
	ratio: number,
	collapsed: boolean,
	viewHeight: number,
): number {
	if (collapsed || viewHeight <= 0) return 0;
	const room = Math.max(
		0,
		viewHeight - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER,
	);
	const wanted = Math.round(room * ratio);
	return Math.max(0, Math.min(wanted, room - ORCHESTRATOR_PANES_MIN));
}

/** The ratio a top area of `contentHeight` px is, in a view `viewHeight`
 *  high: the inverse of `topContentHeight`, for divider drags. */
export function ratioFor(contentHeight: number, viewHeight: number): number {
	const room = viewHeight - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER;
	return room > 0 ? contentHeight / room : 0.5;
}

/** Offset of the panes from the top of the view. */
export function panesTop(contentHeight: number): number {
	return ORCHESTRATOR_TAB_STRIP + contentHeight + ORCHESTRATOR_DIVIDER;
}

/** The **Peek explorer**'s width: its default, and the range a drag keeps
 *  it in. */
export const PEEK_EXPLORER_DEFAULT = 220;
export const PEEK_EXPLORER_MIN = 140;
export const PEEK_EXPLORER_MAX = 480;
/** The peeked terminal always keeps at least this much width. */
export const PEEK_TERMINAL_MIN = 260;

/** A Peek explorer width the user asked for, kept in range. */
export function clampPeekExplorerWidth(width: number): number {
	if (!Number.isFinite(width)) return PEEK_EXPLORER_DEFAULT;
	return Math.round(
		Math.min(PEEK_EXPLORER_MAX, Math.max(PEEK_EXPLORER_MIN, width)),
	);
}

/** The graph (or the selected file tab) beside the Peek keeps at least
 *  this much width while there is room for it. */
export const PEEK_LEFT_MIN = 240;
/** The divider between the graph (or file) and the Peek. */
export const PEEK_DIVIDER = 5;
/** The drag handle on the Peek explorer's left edge. */
export const PEEK_EXPLORER_HANDLE = 5;

/** Widths across the Orchestrator view's top area while there is a Peek:
 *  [left (graph or file) | divider | terminal | handle | explorer]. An
 *  `explorer` of 0 means it is not drawn (and neither is its handle). */
export interface PeekLayout {
	left: number;
	terminal: number;
	explorer: number;
}

/** A Peek terminal width the user dragged to, kept sane. */
export function clampPeekTerminalWidth(width: number): number {
	if (!Number.isFinite(width)) return PEEK_TERMINAL_MIN;
	return Math.round(Math.max(PEEK_TERMINAL_MIN, width));
}

/** Split `space` between the left side and the terminal, the terminal
 *  wanting `terminal`, each keeping its minimum while both fit. */
function split(space: number, terminal: number): PeekLayout {
	if (space < PEEK_LEFT_MIN + PEEK_TERMINAL_MIN) {
		const t = Math.round(space / 2);
		return { left: space - t, terminal: t, explorer: 0 };
	}
	const t = Math.round(
		Math.min(space - PEEK_LEFT_MIN, Math.max(PEEK_TERMINAL_MIN, terminal)),
	);
	return { left: space - t, terminal: t, explorer: 0 };
}

/**
 * The top area's widths with a Peek, in an area `area` px wide.
 *
 * `terminalWidth` is the terminal's width *without* the explorer, as the
 * user dragged it (null: half the area, as before any drag). The explorer
 * (`explorerWidth`, null while hidden) takes its room half from the
 * terminal and half from the left side, so the terminal moves left rather
 * than being squeezed; when one of them reaches its minimum the other gives
 * the rest. With no room for the explorer at its minimum, it is not drawn.
 * An area not measured yet (0) gives all zeros.
 */
export function peekLayout(opts: {
	area: number;
	terminalWidth: number | null;
	explorerWidth: number | null;
}): PeekLayout {
	const { area, terminalWidth, explorerWidth } = opts;
	if (area <= 0) return { left: 0, terminal: 0, explorer: 0 };
	const room = Math.max(0, area - PEEK_DIVIDER);
	const base = terminalWidth ?? room / 2;
	if (explorerWidth === null) return split(room, base);
	const space = room - PEEK_EXPLORER_HANDLE;
	const most = space - PEEK_LEFT_MIN - PEEK_TERMINAL_MIN;
	if (most < PEEK_EXPLORER_MIN) return split(room, base);
	const explorer = Math.min(clampPeekExplorerWidth(explorerWidth), most);
	const rest = space - explorer;
	const terminal = Math.round(
		Math.min(
			rest - PEEK_LEFT_MIN,
			Math.max(PEEK_TERMINAL_MIN, base - explorer / 2),
		),
	);
	return { left: rest - terminal, terminal, explorer };
}

/**
 * The terminal width to remember when the divider is dragged so the left
 * side is `left` px wide: the inverse of `peekLayout`, with the explorer
 * (`explorer`, 0 while not drawn) staying as it is. Kept so both sides
 * keep their minimums, and stored as the width without the explorer, so
 * hiding the explorer later gives the terminal its half back.
 */
export function peekTerminalWidthFor(
	left: number,
	area: number,
	explorer: number,
): number {
	const room =
		area - PEEK_DIVIDER - (explorer > 0 ? PEEK_EXPLORER_HANDLE + explorer : 0);
	const most = Math.max(PEEK_TERMINAL_MIN, room - PEEK_LEFT_MIN);
	const terminal = Math.min(most, Math.max(PEEK_TERMINAL_MIN, room - left));
	return clampPeekTerminalWidth(terminal + explorer / 2);
}

/**
 * The width a drag of the Peek explorer's edge asks for: in range, and no
 * wider than the area can show beside the left side and the terminal at
 * their minimums, so a drag past the edge never stores a width the user did
 * not see. An area not measured yet (0) only keeps it in range.
 */
export function peekExplorerDragWidth(width: number, area: number): number {
	const inRange = clampPeekExplorerWidth(width);
	if (area <= 0) return inRange;
	const most =
		area -
		PEEK_DIVIDER -
		PEEK_EXPLORER_HANDLE -
		PEEK_LEFT_MIN -
		PEEK_TERMINAL_MIN;
	return Math.max(PEEK_EXPLORER_MIN, Math.min(inRange, most));
}

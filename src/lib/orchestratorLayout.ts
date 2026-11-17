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

/**
 * The width the Peek explorer is drawn at in a Peek column `columnWidth`
 * wide: the user's width, narrowed so the terminal keeps
 * `PEEK_TERMINAL_MIN`; 0 (not drawn) when that leaves it under
 * `PEEK_EXPLORER_MIN`. A column not measured yet (0) draws it as asked.
 */
export function peekExplorerShownWidth(
	width: number,
	columnWidth: number,
): number {
	const wanted = clampPeekExplorerWidth(width);
	if (columnWidth <= 0) return wanted;
	const room = columnWidth - PEEK_TERMINAL_MIN;
	if (room < PEEK_EXPLORER_MIN) return 0;
	return Math.min(wanted, room);
}

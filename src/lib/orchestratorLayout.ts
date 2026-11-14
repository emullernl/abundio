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

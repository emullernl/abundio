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
 * Height of the top area's content, clamped so the panes below keep
 * `ORCHESTRATOR_PANES_MIN`. `viewHeight` is the whole view's height (0 when
 * not measured yet: then the stored height is used as is).
 */
export function topContentHeight(
	stored: number,
	collapsed: boolean,
	viewHeight: number,
): number {
	if (collapsed) return 0;
	if (viewHeight <= 0) return stored;
	const room =
		viewHeight -
		ORCHESTRATOR_TAB_STRIP -
		ORCHESTRATOR_DIVIDER -
		ORCHESTRATOR_PANES_MIN;
	return Math.max(0, Math.min(stored, room));
}

/** Offset of the panes from the top of the view. */
export function panesTop(contentHeight: number): number {
	return ORCHESTRATOR_TAB_STRIP + contentHeight + ORCHESTRATOR_DIVIDER;
}

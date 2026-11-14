// Keeping the active Tab in view in an overflowing Tab bar. Pure.

/** Room left beside the Tab when scrolling to it, so its neighbour peeks in
 *  and the user can see there is more. */
export const TAB_SCROLL_MARGIN = 24;

/**
 * The strip's new `scrollLeft` that shows a Tab spanning `left`..`right`
 * (offsets inside the strip's content), or `null` when it is already in
 * full view. Scrolls as little as possible.
 */
export function scrollToShowTab(opts: {
	scrollLeft: number;
	viewWidth: number;
	contentWidth: number;
	left: number;
	right: number;
}): number | null {
	const { scrollLeft, viewWidth, contentWidth, left, right } = opts;
	const max = Math.max(0, contentWidth - viewWidth);
	let next: number | null = null;
	if (left < scrollLeft) next = left - TAB_SCROLL_MARGIN;
	else if (right > scrollLeft + viewWidth)
		next = right - viewWidth + TAB_SCROLL_MARGIN;
	if (next === null) return null;
	return Math.min(max, Math.max(0, next));
}

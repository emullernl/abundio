/**
 * Height split inside the **Pull Requests** section: **Review requested** on
 * top, **My open PRs** below, with a draggable divider between them.
 *
 * One stored number, `reviewShare`: Review requested's fraction of the height
 * holding the two lists. It is a proportion, so it survives window and
 * section resizes; the minimum is in pixels, so it is applied against the
 * measured height every time the split is drawn, not only while dragging.
 */

/** Each list keeps at least its header and about one PR row. */
export const MIN_PR_LIST_PX = 72;

const DEFAULT_SHARE = 0.5;

/** Before the container is measured, neither list is drawn below this share,
 *  so a stored end value (hand-edited) never hides a list for a frame. */
export const MIN_UNMEASURED_SHARE = 0.1;

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

/**
 * The share to draw for a saved (or dragged) `share` in a container
 * `height` pixels tall. An unknown height (0, not yet measured) clamps to
 * MIN_UNMEASURED_SHARE from either end. A container too short for both minimums is split half and half
 * rather than favouring one list.
 */
export function prReviewShare(share: number, height: number): number {
	const s = Number.isFinite(share) ? clamp(share, 0, 1) : DEFAULT_SHARE;
	if (!Number.isFinite(height) || height <= 0)
		return clamp(s, MIN_UNMEASURED_SHARE, 1 - MIN_UNMEASURED_SHARE);
	if (height < 2 * MIN_PR_LIST_PX) return DEFAULT_SHARE;
	const min = MIN_PR_LIST_PX / height;
	return clamp(s, min, 1 - min);
}

/** Height of the divider between the two lists; the lists share the rest. */
export const PR_SPLIT_DIVIDER_PX = 4;

/** The height the two lists share in a container `containerHeight` tall
 *  (the divider's own height taken out); 0 while unmeasured. */
export function prListsHeight(containerHeight: number): number {
	return containerHeight > 0
		? Math.max(0, containerHeight - PR_SPLIT_DIVIDER_PX)
		: 0;
}

/**
 * Dragging the divider to height fraction `y` of its container (0 = top):
 * the share that puts the divider's middle under the pointer. Returns `null`
 * — leave the split alone — when the size is unknown or too short for both
 * minimums, so a drag there never overwrites the saved split with the
 * half-and-half fallback.
 */
export function reviewShareFromDrag(
	y: number,
	containerHeight: number,
): number | null {
	const room = prListsHeight(containerHeight);
	if (room < 2 * MIN_PR_LIST_PX || !Number.isFinite(y)) return null;
	const share = (y * containerHeight - PR_SPLIT_DIVIDER_PX / 2) / room;
	return prReviewShare(share, room);
}

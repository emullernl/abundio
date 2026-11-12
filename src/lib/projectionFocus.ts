/**
 * Whether a terminal should take keyboard focus once it has been projected
 * into a new container.
 *
 * Projecting moves the terminal's element (`appendChild`) and hides it until
 * it has painted. A layout change that re-parents a pane (a split, including
 * one an Agent makes with `abundio`) first retracts the element to its
 * holding container when the old slot goes, then projects it into the new
 * one. Each of those moves drops the browser's focus, so by the time the
 * pane is shown again nothing has focus and the user types into nothing.
 *
 * Whether the element "had" focus cannot be read at projection time: it was
 * already lost at the retract. So the rule is about now instead: the pane is
 * the one keystrokes should go to (the Focused pane, or the Focused tile),
 * and nothing else holds focus. Focus that fell to `<body>` is nothing else;
 * an input, an editor or another terminal is, and is left alone.
 */
export function shouldRefocusAfterProjection({
	isTarget,
	active,
	body,
	termEl,
}: {
	/** This pane is the Focused pane (or Focused tile). */
	isTarget: boolean;
	/** `document.activeElement` now. */
	active: Element | null;
	body: Element | null;
	termEl: Element;
}): boolean {
	if (!isTarget) return false;
	return !active || active === body || termEl.contains(active);
}

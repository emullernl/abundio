/**
 * Whether a terminal should take keyboard focus back once it has been
 * projected into a new container.
 *
 * Projecting moves the terminal's element (`appendChild`) and hides it until
 * it has painted, and both drop the browser's focus. That happens whenever a
 * layout change re-parents a pane: a split, including one an Agent makes with
 * `abundio`. The user then types into nothing. So a terminal that had
 * focus before the move gets it back, but only if it is still the pane
 * keystrokes should go to and nothing else has taken focus in between.
 * Focus that fell to `<body>` because of the move is not "something else".
 */
export function shouldRefocusAfterProjection({
	hadFocus,
	stillTarget,
	active,
	body,
	termEl,
}: {
	hadFocus: boolean;
	/** This pane is still the Focused pane (or Focused tile). */
	stillTarget: boolean;
	/** `document.activeElement` now. */
	active: Element | null;
	body: Element | null;
	termEl: Element;
}): boolean {
	if (!hadFocus || !stillTarget) return false;
	return !active || active === body || termEl.contains(active);
}

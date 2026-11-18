/**
 * The "Toggle markdown preview" shortcut (Cmd/Ctrl+Shift+M) on a markdown
 * File pane switches its view (ADR-0061). The view lives in the pane, so each
 * mounted markdown File pane registers how to switch it here, keyed by pane
 * id: the same way for a pane of a layout and for an Orchestrator tab.
 */

const toggles = new Map<string, () => void>();

/** Returns the unregister function. Unregisters only its own entry. */
export function registerMarkdownViewToggle(
	paneId: string,
	toggle: () => void,
): () => void {
	toggles.set(paneId, toggle);
	return () => {
		if (toggles.get(paneId) === toggle) toggles.delete(paneId);
	};
}

/** Switches the pane's view. False when the pane is not a mounted markdown
 *  File pane (a Preview pane, a terminal, another file). */
export function toggleMarkdownView(paneId: string): boolean {
	const toggle = toggles.get(paneId);
	if (!toggle) return false;
	toggle();
	return true;
}

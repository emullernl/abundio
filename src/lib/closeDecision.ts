/** What should happen when a Window's close is requested. Pure so the branching
 *  policy can be unit-tested without Tauri. See ADR-0016. */
export type WindowCloseDecision =
	| "save-confirm" // unsaved files exist → existing SaveConfirmDialog (it wins)
	| "workspace-confirm" // clean, but ≥1 Opened workspace → workspace confirm
	| "proceed"; // nothing at stake → close immediately

/** Decide how to gate a Window close.
 *
 *  Order matters: the dirty-file Save dialog takes precedence (it already lets
 *  the user save / discard / cancel), so the workspace confirm only fires when
 *  nothing is unsaved. The workspace confirm uses the `> 0` threshold aligned
 *  with the profile-switch confirm. */
export function decideWindowClose(
	dirtyPaneCount: number,
	openedWorkspaceCount: number,
): WindowCloseDecision {
	if (dirtyPaneCount > 0) return "save-confirm";
	if (openedWorkspaceCount > 0) return "workspace-confirm";
	return "proceed";
}

/** What should happen when a Window's close is requested. Pure so the branching
 *  policy can be unit-tested without Tauri. See ADR-0016. */
export type WindowCloseDecision =
	| "save-confirm" // unsaved files exist → existing SaveConfirmDialog (it wins)
	| "workspace-confirm" // clean, but something is Busy → busy confirm
	| "proceed"; // nothing at stake → close immediately

/** Decide how to gate a Window close.
 *
 *  Order matters: the dirty-file Save dialog takes precedence (it already lets
 *  the user save / discard / cancel), so the busy confirm only fires when
 *  nothing is unsaved.
 *
 *  The second test is whether anything is **Busy** — a Working agent or a
 *  running command — not whether any Workspace merely happens to be open. A
 *  Window full of idle shells closes without asking: scrollback, Windows,
 *  Workspaces and layouts are all restored on relaunch, and a prompt the user
 *  always gets is a prompt they stop reading. See ADR-0034, which supersedes
 *  ADR-0016's count-based threshold. */
export function decideWindowClose(
	dirtyPaneCount: number,
	busy: boolean,
): WindowCloseDecision {
	if (dirtyPaneCount > 0) return "save-confirm";
	if (busy) return "workspace-confirm";
	return "proceed";
}

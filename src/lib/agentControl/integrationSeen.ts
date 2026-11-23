/**
 * Which panes' shell integration has reported in (a prompt or a command),
 * for Agent control's `pane run`, which types only into a shell known to be
 * at its prompt. No imports: `terminalManager` writes it while it loads.
 */
const seen = new Set<string>();
let onChange: (() => void) | null = null;

/** A pane's shell integration reported in, or (`false`) its PTY restarted
 *  and has not yet. */
export function setShellIntegrationSeen(paneId: string, value: boolean): void {
	if (seen.has(paneId) === value) return;
	if (value) seen.add(paneId);
	else seen.delete(paneId);
	onChange?.();
}

export function shellIntegrationSeenPanes(): ReadonlySet<string> {
	return seen;
}

/** One listener (`paneFactsSync`); `null` to stop. */
export function onShellIntegrationSeen(fn: (() => void) | null): void {
	onChange = fn;
}

/**
 * How many terminal panes may hold a WebGL context at once, and which ones win
 * when there are more panes than contexts to go around.
 *
 * A browser allows only so many live WebGL contexts per page — Chromium's limit
 * is 16 — and creating one past that silently evicts the oldest, leaving that
 * pane's canvas blank. Abundio keeps a context on every pane of every *opened*
 * workspace (ADR-free, but see the reconciler in `terminalManager.ts`), which is
 * a deliberate trade: disposing and recreating contexts on each workspace switch
 * measured ~3s, and holding them makes switching instant. That trade assumed
 * "well under 16 panes total" and silently breaks once a Profile has enough
 * workspaces open — demo mode opens 24 panes and every pane fights for a
 * context, evicting each other in a loop.
 *
 * So the budget is capped and spent by priority instead. Panes that miss out
 * fall back to xterm's DOM renderer, which renders correctly — it just doesn't
 * use the GPU.
 */

/**
 * Maximum simultaneous WebGL contexts across all terminal panes.
 *
 * Chromium evicts at 16 and Safari/WKWebView is not documented to be higher, so
 * this leaves headroom for anything else on the page that may want a context.
 * Below the cap nothing changes: the common case still keeps every pane on the
 * GPU across workspace switches.
 */
export const MAX_WEBGL_CONTEXTS = 12;

interface TabLike {
	id: string;
	/** Pane ids of this tab's layout, in tree order. */
	paneIds: string[];
}

interface WorkspaceLike {
	id: string;
	tabs: TabLike[];
}

export interface WebglBudgetInput {
	/** Every workspace known to this window, with its tabs' pane ids. */
	workspaces: WorkspaceLike[];
	/** Workspaces whose PTYs are alive — the only ones eligible at all. */
	openedWorkspaceIds: ReadonlySet<string>;
	/** The workspace on screen. Its panes are spent on first. */
	activeWorkspaceId: string | null;
	/** workspaceId → the tab on screen in it. That tab's panes come first
	 *  within its workspace, so a workspace with more panes than the whole
	 *  budget still renders what the user is looking at on the GPU. */
	activeTabByWorkspace: Record<string, string>;
	/** Defaults to MAX_WEBGL_CONTEXTS; injectable for tests. */
	cap?: number;
}

/**
 * The pane ids that should hold a WebGL context, best-first and capped.
 *
 * Priority: the active workspace's active tab, then the rest of the active
 * workspace, then every other opened workspace (active tab first within each).
 * Closed workspaces never qualify. Order within a tab is layout order.
 *
 * Deterministic and pure, so the reconciler's policy can be tested without a
 * browser — a WebGL context is exactly the thing jsdom cannot give us.
 */
export function pickWebglPanes(input: WebglBudgetInput): Set<string> {
	const {
		workspaces,
		openedWorkspaceIds,
		activeWorkspaceId,
		activeTabByWorkspace,
		cap = MAX_WEBGL_CONTEXTS,
	} = input;

	const opened = workspaces.filter((w) => openedWorkspaceIds.has(w.id));
	const ordered = [
		...opened.filter((w) => w.id === activeWorkspaceId),
		...opened.filter((w) => w.id !== activeWorkspaceId),
	];

	const picked = new Set<string>();
	for (const workspace of ordered) {
		const activeTabId = activeTabByWorkspace[workspace.id];
		const tabs = [
			...workspace.tabs.filter((t) => t.id === activeTabId),
			...workspace.tabs.filter((t) => t.id !== activeTabId),
		];
		for (const tab of tabs) {
			for (const paneId of tab.paneIds) {
				if (picked.size >= cap) return picked;
				picked.add(paneId);
			}
		}
	}
	return picked;
}

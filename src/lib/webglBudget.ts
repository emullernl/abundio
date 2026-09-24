/**
 * Which terminal panes hold a WebGL context. See ADR-0041.
 *
 * Only what is on screen, plus one Tab kept warm for switching back: in the
 * **Workspace view**, the visible Tab and the Tab just left; in the **Fleet
 * Console**, the spotlighted tile alone (grid and Filmstrip tiles, and the
 * Workspace view hidden behind the Console, use xterm's DOM renderer). Panes
 * outside the budget render correctly on the DOM renderer — they just do not
 * use the GPU.
 *
 * This replaced holding a context on every pane of every opened Workspace
 * (ADR-0002), which spent contexts on panes nobody could see and, with the
 * Fleet Console showing a dozen agents at once, pushed the page past the
 * browser's limit: Chromium allows 16 live contexts per page and silently
 * evicts the oldest past that, leaving its pane a blank canvas. The price is a
 * rebuild when switching to a Tab that is neither visible nor the one just
 * left — measured ~85 ms for one pane and ~260 ms for eight (Chromium,
 * including two frames) — which the warm Tab spares the common back-and-forth.
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
	/** The workspace on screen. */
	activeWorkspaceId: string | null;
	/** workspaceId → the tab on screen in it. */
	activeTabByWorkspace: Record<string, string>;
	/** The Tab that was on screen before the current one, kept warm so
	 *  switching back is instant. Ignored if it is the visible Tab, or no
	 *  longer exists in an opened Workspace. */
	previousTab?: { workspaceId: string; tabId: string } | null;
	/** Set while the Fleet Console is on screen: then only the spotlighted
	 *  tile qualifies, and nothing at all in the grid. */
	fleetConsole?: { spotlightPaneId: string | null } | null;
	/** Defaults to MAX_WEBGL_CONTEXTS; injectable for tests. */
	cap?: number;
}

/**
 * The pane ids that should hold a WebGL context, best-first and capped.
 *
 * Fleet Console: the spotlighted tile, or none. Workspace view: the visible
 * Tab (the active workspace's active Tab, or its first Tab if that id is
 * stale), then the previously visible Tab. Closed workspaces never qualify.
 * Order within a Tab is layout order.
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
		previousTab,
		fleetConsole,
		cap = MAX_WEBGL_CONTEXTS,
	} = input;

	if (fleetConsole) {
		const spot = fleetConsole.spotlightPaneId;
		return new Set(spot && cap > 0 ? [spot] : []);
	}

	const findTab = (workspaceId: string, tabId?: string): TabLike | null => {
		if (!openedWorkspaceIds.has(workspaceId)) return null;
		const ws = workspaces.find((w) => w.id === workspaceId);
		if (!ws) return null;
		return ws.tabs.find((t) => t.id === tabId) ?? null;
	};

	const tabs: TabLike[] = [];
	if (activeWorkspaceId && openedWorkspaceIds.has(activeWorkspaceId)) {
		const ws = workspaces.find((w) => w.id === activeWorkspaceId);
		// activeTabByWorkspace is persisted and can name a closed tab: fall back
		// to the first, which is what the Workspace view shows then.
		const visible =
			findTab(activeWorkspaceId, activeTabByWorkspace[activeWorkspaceId]) ??
			ws?.tabs[0] ??
			null;
		if (visible) tabs.push(visible);
	}
	if (previousTab) {
		const prev = findTab(previousTab.workspaceId, previousTab.tabId);
		if (prev && !tabs.includes(prev)) tabs.push(prev);
	}

	const picked = new Set<string>();
	for (const tab of tabs) {
		for (const paneId of tab.paneIds) {
			if (picked.size >= cap) return picked;
			picked.add(paneId);
		}
	}
	return picked;
}

export interface WebglReconcilePlan {
	/** Panes to dispose, because they are no longer in the budget. */
	toUnload: string[];
	/** Panes to give a context, in priority order. */
	toLoad: string[];
}

/**
 * What to dispose and what to create to bring the live contexts in line with
 * the budget — the decision the reconciler in `terminalManager.ts` acts on.
 *
 * Unloading has to happen before loading, and this returning both halves is
 * what lets the caller honour that. When every slot is spoken for and the
 * budget moves elsewhere (switching to a workspace whose panes hold none), a
 * caller that interleaves the two would refuse each new pane — the cap is still
 * saturated at the moment it is asked — and then free the contexts afterwards,
 * ending with a visible workspace on the DOM renderer and nothing scheduled to
 * fix it.
 *
 * `toLoad` never exceeds what the cap leaves free after `toUnload` is applied,
 * and follows the budget's own order, so a binding cap spends its slots on the
 * active tab first.
 */
export function webglReconcilePlan(
	loaded: ReadonlySet<string>,
	budget: ReadonlySet<string>,
	cap = MAX_WEBGL_CONTEXTS,
): WebglReconcilePlan {
	const toUnload: string[] = [];
	for (const paneId of loaded) {
		if (!budget.has(paneId)) toUnload.push(paneId);
	}

	let free = cap - (loaded.size - toUnload.length);
	const toLoad: string[] = [];
	for (const paneId of budget) {
		if (free <= 0) break;
		if (loaded.has(paneId)) continue;
		toLoad.push(paneId);
		free--;
	}

	return { toUnload, toLoad };
}

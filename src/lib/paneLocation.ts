import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { containsPane, parseTabLayout } from "./paneTree";

/**
 * Search all workspaces/tabs to find which workspace and tab contain a given pane.
 */
export function findPaneLocation(
	paneId: string,
): { workspaceId: string; tabId: string } | null {
	const { workspaces } = useWorkspaceStore.getState();

	for (const workspace of workspaces) {
		for (const tab of workspace.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (layout && containsPane(layout, paneId)) {
				return { workspaceId: workspace.id, tabId: tab.id };
			}
		}
	}
	return null;
}

/**
 * Show a pane in the Workspace view: its Workspace becomes Active, its Tab
 * active and the pane the Focused pane. `workspaceId`/`tabId` may be passed
 * when the caller already knows them (a notification carries them).
 */
export function revealPane(
	paneId: string | null,
	workspaceId: string,
	tabId: string,
): void {
	const ws = useWorkspaceStore.getState();
	ws.beginWorkspaceSwitch(workspaceId);
	ws.setActiveTab(workspaceId, tabId);
	if (paneId) ws.setFocusedPane(paneId);
}

/**
 * **Switch to**: leave the Fleet Console for one tile's place in the
 * Workspace view. The only way the console changes that view (ADR-0040).
 */
export function switchToPane(paneId: string): void {
	const loc = findPaneLocation(paneId);
	if (!loc) return;
	useWindowUiStore.getState().setFleetConsoleOpen(false);
	revealPane(paneId, loc.workspaceId, loc.tabId);
}

/**
 * **Orchestrator tabs** holding files (ADR-0058): opening, selecting and
 * closing them, and the File pane id each one's buffer lives under. Kept per
 * Profile in the database; loaded when the Orchestrator session starts.
 */

import { useExplorerStore } from "../stores/explorerStore";
import { useOrchestratorStore } from "../stores/orchestratorStore";
import { fallbackProfileId } from "../stores/profileStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import {
	type NewOrchestratorFileTab,
	type OrchestratorFileTab,
	orchestrator as orchestratorApi,
} from "./ipc";
import { workWorkspaces } from "./workspaceKind";

const store = () => useOrchestratorStore.getState();

/** The File pane id an Orchestrator file tab's buffer lives under. Never a
 *  pane of any layout. */
export function tabPaneId(tabId: string): string {
	return `orch-tab:${tabId}`;
}

/** The name a file tab shows: the file's own name. */
export function tabLabel(tab: Pick<OrchestratorFileTab, "path">): string {
	return tab.path.split("/").pop() || tab.path;
}

/** Loads the Profile's file tabs and the selected one. */
export async function loadOrchestratorTabs(profileId: string): Promise<void> {
	try {
		const { tabs, selected } = await orchestratorApi.tabs(profileId);
		store().set({ fileTabs: tabs, selectedTabId: selected });
	} catch (e) {
		console.warn("[orchestrator] could not load its tabs", e);
	}
}

/** Selects a file tab, or the graph (`null`), and remembers it. */
export function selectOrchestratorTab(id: string | null): void {
	store().set({ selectedTabId: id, fileTabFocused: false });
	orchestratorApi.selectTab(fallbackProfileId(), id).catch(() => {});
}

/**
 * Opens a file in an Orchestrator tab, or finds the tab it is already open
 * in. `focus` selects it; otherwise it opens behind the current tab.
 * Returns the tab.
 */
export async function openOrchestratorFile(
	tab: NewOrchestratorFileTab,
	{ focus }: { focus: boolean },
): Promise<OrchestratorFileTab> {
	const made = await orchestratorApi.addTab(fallbackProfileId(), tab);
	const tabs = store().fileTabs;
	if (!tabs.some((t) => t.id === made.id)) {
		store().set({ fileTabs: [...tabs, made] });
	}
	if (focus) selectOrchestratorTab(made.id);
	return made;
}

/** Whether a file tab holds unsaved edits. */
export function tabIsDirty(tabId: string): boolean {
	return !!useExplorerStore.getState().filePanes[tabPaneId(tabId)]?.isDirty;
}

/** Asks to close a file tab: closes it at once, or, with unsaved edits,
 *  asks first (the tab strip shows the question). */
export function requestCloseOrchestratorTab(id: string): void {
	if (tabIsDirty(id)) store().set({ closingTabId: id });
	else closeOrchestratorTab(id);
}

/** Closes a file tab (the caller asked about unsaved edits first). The tab
 *  to its left, or the graph, is selected if it was. */
export function closeOrchestratorTab(id: string): void {
	const { fileTabs, selectedTabId } = store();
	const i = fileTabs.findIndex((t) => t.id === id);
	if (i < 0) return;
	const rest = fileTabs.filter((t) => t.id !== id);
	store().set({ fileTabs: rest });
	if (selectedTabId === id) {
		selectOrchestratorTab(rest[i - 1]?.id ?? null);
	}
	orchestratorApi.removeTab(fallbackProfileId(), id).catch(() => {});
}

/** The Workspaces whose files are open in Orchestrator tabs: their folders
 *  are watched, so the tabs reload on outside changes. */
export function tabWorkspaceIds(
	tabs: readonly OrchestratorFileTab[],
): string[] {
	return [...new Set(tabs.map((t) => t.workspaceId))];
}

/**
 * Opens (or closes) the file search over the Profile's Workspaces, for an
 * Orchestrator tab: every Workspace but the Orchestrator's own, or only
 * `workspaceIds` (a Workspace's "Open file…").
 */
export function toggleOrchestratorFileSearch(workspaceIds?: string[]): void {
	if (store().fileSearch && !workspaceIds) {
		store().set({ fileSearch: null });
		return;
	}
	const { workspaces, missingFolderIds } = useWorkspaceStore.getState();
	const ids =
		workspaceIds ??
		workWorkspaces(workspaces)
			.filter((w) => !missingFolderIds.has(w.id))
			.map((w) => w.id);
	store().set({ fileSearch: { workspaceIds: ids } });
}

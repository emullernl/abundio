import { create } from "zustand";
import { collectFilePaneIds, parseTabLayout } from "../lib/paneTree";
import { useExplorerStore } from "./explorerStore";
import { useWorkspaceStore } from "./workspaceStore";

interface TabCloseConfirmState {
	pendingTabId: string | null;
	pendingDirtyFileName: string | null;
	pendingOnClean: (() => void) | null;
}

export const useTabCloseConfirmStore = create<TabCloseConfirmState>(() => ({
	pendingTabId: null,
	pendingDirtyFileName: null,
	pendingOnClean: null,
}));

export function requestTabCloseWithDirtyCheck(
	tabId: string,
	onClean: () => void,
): void {
	const tab = useWorkspaceStore
		.getState()
		.workspaces.flatMap((w) => w.tabs)
		.find((t) => t.id === tabId);

	if (!tab) {
		onClean();
		return;
	}

	const layout = parseTabLayout(tab.layoutJson);
	if (!layout) {
		onClean();
		return;
	}

	const filePanes = useExplorerStore.getState().filePanes;
	const dirtyPanes = collectFilePaneIds(layout).filter(
		(id) => filePanes[id]?.isDirty,
	);

	if (dirtyPanes.length === 0) {
		onClean();
		return;
	}

	const name =
		dirtyPanes.length === 1
			? (filePanes[dirtyPanes[0]]?.fileName ?? "file")
			: `${dirtyPanes.length} files`;

	useTabCloseConfirmStore.setState({
		pendingTabId: tabId,
		pendingDirtyFileName: name,
		pendingOnClean: onClean,
	});
}

export function clearTabClose(): void {
	useTabCloseConfirmStore.setState({
		pendingTabId: null,
		pendingDirtyFileName: null,
		pendingOnClean: null,
	});
}

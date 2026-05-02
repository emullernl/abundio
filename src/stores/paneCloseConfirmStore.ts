import { create } from "zustand";
import { useExplorerStore } from "./explorerStore";

interface PaneCloseConfirmState {
	pendingPaneId: string | null;
	pendingLabel: string | null;
	pendingDirtyFileName: string | null;
}

export const usePaneCloseConfirmStore = create<PaneCloseConfirmState>(() => ({
	pendingPaneId: null,
	pendingLabel: null,
	pendingDirtyFileName: null,
}));

export function requestPaneClose(paneId: string, label?: string): void {
	const pane = useExplorerStore.getState().filePanes[paneId];
	const dirtyFileName = pane?.isDirty ? pane.fileName : null;
	usePaneCloseConfirmStore.setState({
		pendingPaneId: paneId,
		pendingLabel: label ?? null,
		pendingDirtyFileName: dirtyFileName,
	});
}

export function clearPaneClose(): void {
	usePaneCloseConfirmStore.setState({
		pendingPaneId: null,
		pendingLabel: null,
		pendingDirtyFileName: null,
	});
}

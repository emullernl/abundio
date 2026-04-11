import { useCallback, useState } from "react";
import { useExplorerStore } from "../stores/explorerStore";

export function useConfirmCloseFileTab() {
	const [pendingTabId, setPendingTabId] = useState<string | null>(null);

	const requestClose = useCallback((tabId: string) => {
		const tab = useExplorerStore
			.getState()
			.fileTabs.find((t) => t.id === tabId);
		if (!tab || !tab.isDirty) {
			useExplorerStore.getState().closeFileTab(tabId);
			return;
		}
		setPendingTabId(tabId);
	}, []);

	const pendingTab = pendingTabId
		? useExplorerStore.getState().fileTabs.find((t) => t.id === pendingTabId)
		: null;

	const dialogProps = pendingTab
		? {
				fileName: pendingTab.fileName,
				onSave: async () => {
					await useExplorerStore.getState().saveFile(pendingTab.id);
					useExplorerStore.getState().closeFileTab(pendingTab.id);
					setPendingTabId(null);
				},
				onDontSave: () => {
					useExplorerStore.getState().closeFileTab(pendingTab.id);
					setPendingTabId(null);
				},
				onCancel: () => {
					setPendingTabId(null);
				},
			}
		: null;

	return { requestClose, dialogProps };
}

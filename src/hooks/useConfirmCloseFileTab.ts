import { useCallback, useState } from "react";
import { useExplorerStore } from "../stores/explorerStore";
import { useSplitPane } from "./useSplitPane";

export function useConfirmCloseFileTab() {
	const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
	const { closePane } = useSplitPane();

	const requestClose = useCallback(
		(paneId: string) => {
			const pane = useExplorerStore.getState().filePanes[paneId];
			if (!pane?.isDirty) {
				closePane(paneId);
				return;
			}
			setPendingPaneId(paneId);
		},
		[closePane],
	);

	const pendingPane = pendingPaneId
		? useExplorerStore.getState().filePanes[pendingPaneId]
		: null;

	const dialogProps =
		pendingPane && pendingPaneId
			? {
					fileName: pendingPane.fileName,
					onSave: async () => {
						await useExplorerStore.getState().saveFile(pendingPaneId);
						await closePane(pendingPaneId);
						setPendingPaneId(null);
					},
					onDontSave: async () => {
						await closePane(pendingPaneId);
						setPendingPaneId(null);
					},
					onCancel: () => {
						setPendingPaneId(null);
					},
				}
			: null;

	return { requestClose, dialogProps };
}

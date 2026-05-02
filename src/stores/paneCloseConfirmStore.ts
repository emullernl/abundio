import { create } from "zustand";

interface PaneCloseConfirmState {
	pendingPaneId: string | null;
	pendingLabel: string | null;
}

export const usePaneCloseConfirmStore = create<PaneCloseConfirmState>(() => ({
	pendingPaneId: null,
	pendingLabel: null,
}));

export function requestPaneClose(paneId: string, label?: string): void {
	usePaneCloseConfirmStore.setState({
		pendingPaneId: paneId,
		pendingLabel: label ?? null,
	});
}

export function clearPaneClose(): void {
	usePaneCloseConfirmStore.setState({
		pendingPaneId: null,
		pendingLabel: null,
	});
}

import { create } from "zustand";

// Ephemeral state for the OS file-drop drag-over highlight. Holds the terminal
// pane currently under the cursor during an OS file drag, so FileDropHighlight
// can light up the right pane. Separate from `dragPaneStore` (mouse-driven pane
// reordering) — the two drag systems are orthogonal.
interface FileDropState {
	hoverPaneId: string | null;
	setHoverPane: (paneId: string | null) => void;
}

export const useFileDropStore = create<FileDropState>((set) => ({
	hoverPaneId: null,
	setHoverPane: (hoverPaneId) =>
		set((s) => (s.hoverPaneId === hoverPaneId ? s : { hoverPaneId })),
}));

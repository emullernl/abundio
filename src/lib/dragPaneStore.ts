import { create } from "zustand";

export type DropEdge = "top" | "right" | "bottom" | "left";

export type DropTarget =
	| { kind: "pane-edge"; tabId: string; paneId: string; edge: DropEdge }
	| { kind: "tab"; tabId: string }
	| { kind: "new-tab" }
	| null;

interface DragPaneState {
	isDragging: boolean;
	sourceTabId: string | null;
	sourcePaneId: string | null;
	sourceRect: { width: number; height: number } | null;
	grabOffset: { x: number; y: number } | null;
	cursor: { x: number; y: number };
	hoverTarget: DropTarget;

	startDrag: (
		sourcePaneId: string,
		sourceTabId: string,
		sourceRect: { width: number; height: number },
		grabOffset: { x: number; y: number },
		cursor: { x: number; y: number },
	) => void;
	updateCursor: (x: number, y: number) => void;
	setHoverTarget: (t: DropTarget) => void;
	endDrag: () => void;
}

export const useDragPaneStore = create<DragPaneState>((set) => ({
	isDragging: false,
	sourceTabId: null,
	sourcePaneId: null,
	sourceRect: null,
	grabOffset: null,
	cursor: { x: 0, y: 0 },
	hoverTarget: null,

	startDrag: (sourcePaneId, sourceTabId, sourceRect, grabOffset, cursor) =>
		set({
			isDragging: true,
			sourcePaneId,
			sourceTabId,
			sourceRect,
			grabOffset,
			cursor,
			hoverTarget: null,
		}),

	updateCursor: (x, y) => set({ cursor: { x, y } }),

	setHoverTarget: (hoverTarget) => set({ hoverTarget }),

	endDrag: () =>
		set({
			isDragging: false,
			sourceTabId: null,
			sourcePaneId: null,
			sourceRect: null,
			grabOffset: null,
			cursor: { x: 0, y: 0 },
			hoverTarget: null,
		}),
}));

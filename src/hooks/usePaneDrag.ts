import { useCallback, useRef } from "react";
import { hitTest } from "../lib/dragPaneHitTest";
import { useDragPaneStore } from "../lib/dragPaneStore";
import { collectPaneIds } from "../lib/paneTree";
import type { PaneNode } from "../lib/types";
import { useWorkspaceStore } from "../stores/workspaceStore";

function buildPaneTabMap(): Record<string, string> {
	const state = useWorkspaceStore.getState();
	const workspace = state.workspaces.find(
		(w) => w.id === state.activeWorkspaceId,
	);
	if (!workspace) return {};
	const map: Record<string, string> = {};
	for (const tab of workspace.tabs) {
		try {
			for (const id of collectPaneIds(JSON.parse(tab.layoutJson) as PaneNode)) {
				map[id] = tab.id;
			}
		} catch {
			// ignore malformed layout
		}
	}
	return map;
}

export function usePaneDrag(paneId: string) {
	const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastHoveredTabRef = useRef<string | null>(null);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();

			const startX = e.clientX;
			const startY = e.clientY;
			let dragStarted = false;
			let paneTabMap: Record<string, string> = {};

			const cancel = () => {
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				document.removeEventListener("keydown", onKeyDown, true);
				document.body.classList.remove("dragging-pane");
				if (dwellTimerRef.current) {
					clearTimeout(dwellTimerRef.current);
					dwellTimerRef.current = null;
				}
				lastHoveredTabRef.current = null;
				if (dragStarted) {
					useDragPaneStore.getState().endDrag();
					dragStarted = false;
				}
			};

			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
				}
			};

			const onMouseMove = (e: MouseEvent) => {
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;

				if (!dragStarted && Math.hypot(dx, dy) > 4) {
					// Look up the source pane's tab
					const state = useWorkspaceStore.getState();
					const workspace = state.workspaces.find(
						(w) => w.id === state.activeWorkspaceId,
					);
					const sourceTabId = workspace?.tabs.find((t) => {
						try {
							return collectPaneIds(
								JSON.parse(t.layoutJson) as PaneNode,
							).includes(paneId);
						} catch {
							return false;
						}
					})?.id;

					if (!sourceTabId) {
						cancel();
						return;
					}

					// Find source element for sizing — use data-pane-id container
					const sourceEl = document.querySelector<HTMLElement>(
						`[data-pane-id="${paneId}"]`,
					);
					const rect = sourceEl?.getBoundingClientRect();
					const sourceRect = rect
						? { width: rect.width, height: rect.height }
						: { width: 300, height: 200 };
					const grabOffset = {
						x: startX - (rect?.left ?? startX),
						y: startY - (rect?.top ?? startY),
					};

					paneTabMap = buildPaneTabMap();

					useDragPaneStore
						.getState()
						.startDrag(paneId, sourceTabId, sourceRect, grabOffset, {
							x: e.clientX,
							y: e.clientY,
						});
					document.body.classList.add("dragging-pane");
					document.addEventListener("keydown", onKeyDown, true);
					dragStarted = true;
				}

				if (!dragStarted) return;

				useDragPaneStore.getState().updateCursor(e.clientX, e.clientY);

				const target = hitTest(e.clientX, e.clientY, paneId, paneTabMap);
				useDragPaneStore.getState().setHoverTarget(target);

				// Dwell-activate non-active tabs
				if (target?.kind === "tab") {
					if (target.tabId !== lastHoveredTabRef.current) {
						if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
						lastHoveredTabRef.current = target.tabId;
						const tabIdToActivate = target.tabId;
						dwellTimerRef.current = setTimeout(() => {
							const ws = useWorkspaceStore.getState().getActiveWorkspace();
							if (ws) {
								useWorkspaceStore
									.getState()
									.setActiveTab(ws.id, tabIdToActivate);
								// Rebuild map since active tab changed
								paneTabMap = buildPaneTabMap();
							}
						}, 350);
					}
				} else {
					if (dwellTimerRef.current) {
						clearTimeout(dwellTimerRef.current);
						dwellTimerRef.current = null;
					}
					lastHoveredTabRef.current = null;
				}
			};

			const onMouseUp = async () => {
				if (!dragStarted) {
					cancel();
					return;
				}

				const { hoverTarget, sourceTabId } = useDragPaneStore.getState();

				if (
					hoverTarget &&
					sourceTabId &&
					!(
						hoverTarget.kind === "pane-edge" && hoverTarget.paneId === paneId
					) &&
					hoverTarget.kind !== "tab"
				) {
					await useWorkspaceStore
						.getState()
						.movePaneToTarget(sourceTabId, paneId, hoverTarget);
				}

				cancel();
			};

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[paneId],
	);

	return { handleMouseDown };
}

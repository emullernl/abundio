import type { DropTarget } from "./dragPaneStore";

export function hitTest(
	x: number,
	y: number,
	sourcePaneId: string,
	paneTabMap: Record<string, string>,
): DropTarget {
	// 1. Tab strip has priority — any cursor y within the strip handles tab/new-tab drops
	// Use querySelectorAll + visibility check because multiple workspaces render their
	// tab strips simultaneously (inactive ones are hidden via display:none on a parent).
	const tabStripEl = Array.from(
		document.querySelectorAll<HTMLElement>("[data-tab-strip]"),
	).find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
	if (tabStripEl) {
		const rect = tabStripEl.getBoundingClientRect();
		if (
			x >= rect.left &&
			x <= rect.right &&
			y >= rect.top &&
			y <= rect.bottom
		) {
			const el = document.elementFromPoint(x, y);
			if (el) {
				if (el.closest("[data-new-tab-button]")) return { kind: "new-tab" };
				const tabEl = el.closest<HTMLElement>("[data-tab-id]");
				if (tabEl) {
					const tabId = tabEl.getAttribute("data-tab-id");
					if (tabId) return { kind: "tab", tabId };
				}
			}
			// In strip but not on a specific tab or + button → new-tab zone
			return { kind: "new-tab" };
		}
	}

	// 2. Pane edge detection via data-pane-id on pane containers
	const el = document.elementFromPoint(x, y);
	if (!el) return null;

	const paneEl = el.closest<HTMLElement>("[data-pane-id]");
	if (!paneEl) return null;

	const paneId = paneEl.getAttribute("data-pane-id");
	if (!paneId || paneId === sourcePaneId) return null;

	const tabId = paneTabMap[paneId];
	if (!tabId) return null;

	const rect = paneEl.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) return null;

	// Diagonal triangle classification: divide pane into 4 triangles via both diagonals
	const relX = (x - rect.left) / rect.width;
	const relY = (y - rect.top) / rect.height;
	const aboveDiag1 = relY < relX; // above top-left → bottom-right diagonal
	const aboveDiag2 = relY < 1 - relX; // above top-right → bottom-left diagonal

	let edge: "top" | "right" | "bottom" | "left";
	if (aboveDiag1 && aboveDiag2) edge = "top";
	else if (aboveDiag1) edge = "right";
	else if (!aboveDiag2) edge = "bottom";
	else edge = "left";

	return { kind: "pane-edge", tabId, paneId, edge };
}

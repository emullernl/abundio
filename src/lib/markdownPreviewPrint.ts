// Bridges the "Print" action on a markdown file pane to its preview pane,
// which lives in a separate component and owns the rendered DOM. Keyed by
// the source (file) pane id.

type PrintFn = () => void;

const printers = new Map<string, PrintFn>();
const pendingPrint = new Set<string>();

/** Called by a preview pane while it is mounted. */
export function registerPreviewPrinter(
	sourcePaneId: string,
	fn: PrintFn,
): void {
	printers.set(sourcePaneId, fn);
}

export function unregisterPreviewPrinter(sourcePaneId: string): void {
	printers.delete(sourcePaneId);
	pendingPrint.delete(sourcePaneId);
}

/**
 * Consumed by a preview pane once it has rendered: if a print was requested
 * before the pane existed, this returns true so the pane can print itself.
 */
export function consumePendingPrint(sourcePaneId: string): boolean {
	if (!pendingPrint.has(sourcePaneId)) return false;
	pendingPrint.delete(sourcePaneId);
	return true;
}

/**
 * Print the preview for a source pane. If the preview pane is already mounted
 * its printer runs immediately; otherwise the request is held until the pane
 * mounts and consumes it (the caller is expected to open the preview).
 */
export function requestPreviewPrint(sourcePaneId: string): void {
	const fn = printers.get(sourcePaneId);
	if (fn) {
		fn();
		return;
	}
	pendingPrint.add(sourcePaneId);
}

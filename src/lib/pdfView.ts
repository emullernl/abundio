/**
 * Pure rules for the PDF view (docs/plans/pdf-viewer.md): the remembered
 * position, zoom steps, and what a link click does.
 */

/** A zoom: a scale (1 = 100%), or fit the page's width to the view. */
export type PdfZoom = number | "page-width";

/** Where a PDF view is: its page (from 1) and zoom. Remembered on the layout
 *  node, the File window or the Orchestrator tab. */
export interface PdfPosition {
	page: number;
	zoom: PdfZoom;
}

export const DEFAULT_PDF_POSITION: PdfPosition = {
	page: 1,
	zoom: "page-width",
};

export const MIN_PDF_SCALE = 0.25;
export const MAX_PDF_SCALE = 5;

/** The scales Zoom in / out step through. */
const ZOOM_STEPS = [
	0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
	5,
];

/** A stored position, checked: anything else (a hand-edited database, a newer
 *  build's shape) reads as `null`, and the view starts at its default. */
export function parsePdfPosition(value: unknown): PdfPosition | null {
	if (typeof value === "string") {
		try {
			return parsePdfPosition(JSON.parse(value));
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") return null;
	const { page, zoom } = value as { page?: unknown; zoom?: unknown };
	if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
		return null;
	}
	if (zoom === "page-width") return { page, zoom };
	if (
		typeof zoom === "number" &&
		Number.isFinite(zoom) &&
		zoom >= MIN_PDF_SCALE &&
		zoom <= MAX_PDF_SCALE
	) {
		return { page, zoom };
	}
	return null;
}

/** A position that fits a document of `pageCount` pages: a reload of a file
 *  that got shorter lands on its last page. */
export function clampPdfPosition(
	position: PdfPosition,
	pageCount: number,
): PdfPosition {
	const last = Math.max(1, pageCount);
	const page = Math.min(Math.max(1, Math.round(position.page)), last);
	return page === position.page ? position : { ...position, page };
}

/** The next scale up (`+1`) or down (`-1`) from `scale`. */
export function stepPdfZoom(scale: number, direction: 1 | -1): number {
	// Within a hair of a step counts as on it, so 0.9999 steps past 1.
	const eps = 0.001;
	if (direction > 0) {
		return ZOOM_STEPS.find((s) => s > scale + eps) ?? MAX_PDF_SCALE;
	}
	for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
		if (ZOOM_STEPS[i] < scale - eps) return ZOOM_STEPS[i];
	}
	return MIN_PDF_SCALE;
}

/** The factor one pinch or Cmd/Ctrl+wheel event scales by: smooth, so a
 *  trackpad's stream of small events zooms gradually, and kept so the result
 *  stays within the scales a position may hold. */
export function pinchScaleFactor(scale: number, deltaY: number): number {
	// A wheel notch is ~100; a trackpad pinch sends many deltas of a few.
	const delta = Math.max(-50, Math.min(50, deltaY));
	const wanted = scale * Math.exp(-delta / 100);
	const next = Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, wanted));
	return scale > 0 ? next / scale : 1;
}

/** Two positions name the same place. */
export function samePdfPosition(a: PdfPosition, b: PdfPosition): boolean {
	return a.page === b.page && a.zoom === b.zoom;
}

/** What a click on a link in a PDF does: `internal` links (`#…`, handled by
 *  pdf.js itself) jump within the document; `http(s)` and `mailto` open in
 *  the browser; anything else (`file:`, `javascript:`, relative paths, other
 *  apps' schemes) is ignored. */
export type PdfLinkAction =
	| { kind: "internal" }
	| { kind: "external"; url: string }
	| { kind: "ignore" };

const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

export function classifyPdfLink(href: string | null): PdfLinkAction {
	if (href == null) return { kind: "ignore" };
	const raw = href.trim();
	if (raw.startsWith("#")) return { kind: "internal" };
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
	if (scheme && EXTERNAL_SCHEMES.has(scheme)) {
		return { kind: "external", url: raw };
	}
	return { kind: "ignore" };
}

/** A label for a zoom: `Fit width` or a percentage. */
export function pdfZoomLabel(zoom: PdfZoom): string {
	return zoom === "page-width" ? "Fit width" : `${Math.round(zoom * 100)}%`;
}

/** Whether a path names a PDF, by its extension. */
export function isPdfPath(path: string): boolean {
	return /\.pdf$/i.test(path);
}

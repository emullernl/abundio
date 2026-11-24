/**
 * Loads pdf.js on first use, so the app's start never pays for it. The legacy
 * build runs on older webviews (WebKitGTK on older Linux distributions). Its
 * viewer module reads the library from `globalThis.pdfjsLib`, which the
 * library sets on import, so the library must load first.
 *
 * The fonts, CMaps, colour profiles and wasm decoders come from `/pdfjs/`,
 * which `vite.config.ts` serves and bundles; nothing is fetched from the
 * network.
 */
import rendererUrl from "pdfjs-dist/legacy/build/pdf.renderer.min.mjs?url";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
export type PdfjsViewer = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

let loading: Promise<{ lib: PdfjsLib; viewer: PdfjsViewer }> | null = null;

export function loadPdfjs(): Promise<{ lib: PdfjsLib; viewer: PdfjsViewer }> {
	loading ??= (async () => {
		const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
		lib.GlobalWorkerOptions.workerSrc = workerUrl;
		// Without it pages are drawn on the main thread, and scrolling and
		// zooming stall while each page draws.
		lib.GlobalWorkerOptions.rendererSrc = rendererUrl;
		const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
		await import("pdfjs-dist/legacy/web/pdf_viewer.css");
		return { lib, viewer };
	})();
	// A failed load (a missing chunk) may be retried by the next view.
	loading.catch(() => {
		loading = null;
	});
	return loading;
}

/** Where pdf.js finds its data files, as `getDocument` options. */
export const PDF_DATA_URLS = {
	cMapUrl: "/pdfjs/cmaps/",
	cMapPacked: true,
	standardFontDataUrl: "/pdfjs/standard_fonts/",
	iccUrl: "/pdfjs/iccs/",
	wasmUrl: "/pdfjs/wasm/",
} as const;

/**
 * Print a PDF (docs/plans/pdf-viewer.md). Each page is drawn by pdf.js at
 * print resolution into an image, the images go into a print-only element,
 * and the webview's own print dialog prints them — the way `markdownPrint.ts`
 * prints rendered markdown. One page per sheet, sized as the PDF's first page,
 * with no margin: the PDF carries its own.
 */

const PRINT_DIV_ID = "abundio-pdf-print";
const PRINT_STYLE_ID = "abundio-pdf-print-style";

/** Dots per inch pages are drawn at. 150 prints text sharply and keeps a
 *  long document's memory reasonable. */
export const PRINT_DPI = 150;
/** PDF user space is in points, 72 to the inch. */
const PDF_POINTS_PER_INCH = 72;

/** The print stylesheet: only the print element shows, one page per sheet. */
export function pdfPrintCss(widthPt: number, heightPt: number): string {
	return `
@page { size: ${widthPt}pt ${heightPt}pt; margin: 0; }
@media print {
  html, body {
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #fff !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  body > *:not(#${PRINT_DIV_ID}) { display: none !important; }
  #${PRINT_DIV_ID} { display: block !important; }
  #${PRINT_DIV_ID} > div {
    width: ${widthPt}pt;
    height: ${heightPt}pt;
    overflow: hidden;
    break-after: page;
    page-break-after: always;
  }
  #${PRINT_DIV_ID} > div:last-child { break-after: auto; page-break-after: auto; }
  #${PRINT_DIV_ID} img { width: 100%; height: 100%; object-fit: contain; display: block; }
}`;
}

/** What `printPdf` needs of a pdf.js document. */
export interface PrintableDoc {
	numPages: number;
	getPage(n: number): Promise<{
		getViewport(o: { scale: number }): { width: number; height: number };
		render(o: {
			canvas: HTMLCanvasElement;
			viewport: { width: number; height: number };
			intent: string;
			annotationMode: number;
			background: string;
		}): { promise: Promise<void>; cancel(): void };
		cleanup(): void;
	}>;
}

/** Thrown when the user cancels while pages are still being drawn. */
export class PrintCancelled extends Error {}

/** AnnotationMode.ENABLE_STORAGE: form fields print with their values. */
const ANNOTATION_MODE_STORAGE = 3;

function removeLeftovers(): void {
	const div = document.getElementById(PRINT_DIV_ID);
	if (div) {
		for (const img of Array.from(div.querySelectorAll("img"))) {
			URL.revokeObjectURL(img.src);
		}
		div.remove();
	}
	document.getElementById(PRINT_STYLE_ID)?.remove();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) =>
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error("could not draw a page"))),
			"image/png",
		),
	);
}

/**
 * Draws every page, then opens the print dialog. `onProgress` hears each page
 * drawn; aborting `signal` stops drawing and throws `PrintCancelled`.
 */
export async function printPdf(
	doc: PrintableDoc,
	{
		onProgress,
		signal,
	}: {
		onProgress?: (done: number, total: number) => void;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	removeLeftovers();
	const total = doc.numPages;
	const first = (await doc.getPage(1)).getViewport({ scale: 1 });

	const div = document.createElement("div");
	div.id = PRINT_DIV_ID;
	div.style.display = "none";
	const scale = PRINT_DPI / PDF_POINTS_PER_INCH;
	try {
		for (let n = 1; n <= total; n++) {
			if (signal?.aborted) throw new PrintCancelled();
			const page = await doc.getPage(n);
			const viewport = page.getViewport({ scale });
			const canvas = document.createElement("canvas");
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			const task = page.render({
				canvas,
				viewport,
				intent: "print",
				annotationMode: ANNOTATION_MODE_STORAGE,
				background: "#ffffff",
			});
			const onAbort = () => task.cancel();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await task.promise;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			if (signal?.aborted) throw new PrintCancelled();
			const blob = await canvasToBlob(canvas);
			// Free the canvas's memory at once; the image holds the page now.
			canvas.width = 0;
			canvas.height = 0;
			page.cleanup();
			const sheet = document.createElement("div");
			const img = document.createElement("img");
			img.src = URL.createObjectURL(blob);
			img.alt = `Page ${n}`;
			sheet.appendChild(img);
			div.appendChild(sheet);
			onProgress?.(n, total);
		}
	} catch (e) {
		for (const img of Array.from(div.querySelectorAll("img"))) {
			URL.revokeObjectURL(img.src);
		}
		throw signal?.aborted ? new PrintCancelled() : e;
	}

	const style = document.createElement("style");
	style.id = PRINT_STYLE_ID;
	style.textContent = pdfPrintCss(first.width, first.height);
	document.head.appendChild(style);
	document.body.appendChild(div);

	// Every image must be decoded before the dialog snapshots the page.
	await Promise.all(
		Array.from(div.querySelectorAll("img")).map((img) =>
			img.decode().catch(() => {}),
		),
	);
	window.addEventListener("afterprint", removeLeftovers, { once: true });
	window.print();
}

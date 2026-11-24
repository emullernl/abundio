import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PRINT_DPI,
	type PrintableDoc,
	PrintCancelled,
	pdfPrintCss,
	printPdf,
} from "../pdfPrint";

// jsdom draws nothing: canvases give a fixed blob, images decode at once.
beforeEach(() => {
	HTMLCanvasElement.prototype.toBlob = (cb: BlobCallback) => {
		cb(new Blob(["png"], { type: "image/png" }));
	};
	HTMLImageElement.prototype.decode = () => Promise.resolve();
	URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
	URL.revokeObjectURL = vi.fn();
	window.print = vi.fn();
});

afterEach(() => {
	window.dispatchEvent(new Event("afterprint"));
});

function fakeDoc(numPages: number, onRender?: (n: number) => void) {
	const renders: { n: number; scale: number; intent: string }[] = [];
	const doc: PrintableDoc = {
		numPages,
		getPage: async (n) => ({
			getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
			render: (o) => {
				renders.push({
					n,
					scale: o.viewport.width / 612,
					intent: o.intent,
				});
				onRender?.(n);
				return { promise: Promise.resolve(), cancel: () => {} };
			},
			cleanup: () => {},
		}),
	};
	return { doc, renders };
}

describe("pdfPrintCss", () => {
	it("sizes the sheet as the page, with no margin", () => {
		const css = pdfPrintCss(612, 792);
		expect(css).toContain("@page { size: 612pt 792pt; margin: 0; }");
		expect(css).toContain("break-after: page");
	});
});

describe("printPdf", () => {
	it("draws every page for print, then opens the print dialog", async () => {
		const { doc, renders } = fakeDoc(3);
		const progress: number[] = [];
		await printPdf(doc, { onProgress: (done) => progress.push(done) });
		expect(renders.map((r) => r.n)).toEqual([1, 2, 3]);
		expect(renders[0].scale).toBeCloseTo(PRINT_DPI / 72);
		expect(renders.every((r) => r.intent === "print")).toBe(true);
		expect(progress).toEqual([1, 2, 3]);
		const imgs = document.querySelectorAll("#abundio-pdf-print img");
		expect(imgs).toHaveLength(3);
		expect(window.print).toHaveBeenCalledTimes(1);
	});

	it("cleans up after the dialog closes", async () => {
		const { doc } = fakeDoc(2);
		await printPdf(doc);
		window.dispatchEvent(new Event("afterprint"));
		expect(document.getElementById("abundio-pdf-print")).toBeNull();
		expect(document.getElementById("abundio-pdf-print-style")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
	});

	it("stops when cancelled, and never opens the dialog", async () => {
		const abort = new AbortController();
		const { doc, renders } = fakeDoc(10, (n) => {
			if (n === 2) abort.abort();
		});
		await expect(
			printPdf(doc, { signal: abort.signal }),
		).rejects.toBeInstanceOf(PrintCancelled);
		expect(renders).toHaveLength(2);
		expect(window.print).not.toHaveBeenCalled();
		expect(document.getElementById("abundio-pdf-print")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import {
	clampPdfPosition,
	classifyPdfLink,
	isPdfPath,
	MAX_PDF_SCALE,
	MIN_PDF_SCALE,
	parsePdfPosition,
	pdfZoomLabel,
	stepPdfZoom,
} from "../pdfView";

describe("parsePdfPosition", () => {
	it("reads a stored position, as an object or as JSON", () => {
		expect(parsePdfPosition({ page: 3, zoom: 1.5 })).toEqual({
			page: 3,
			zoom: 1.5,
		});
		expect(parsePdfPosition('{"page":2,"zoom":"page-width"}')).toEqual({
			page: 2,
			zoom: "page-width",
		});
	});

	it("refuses anything else", () => {
		for (const bad of [
			null,
			undefined,
			"",
			"not json",
			{},
			{ page: 0, zoom: 1 },
			{ page: 1.5, zoom: 1 },
			{ page: "1", zoom: 1 },
			{ page: 1, zoom: "page-fit" },
			{ page: 1, zoom: MAX_PDF_SCALE + 1 },
			{ page: 1, zoom: MIN_PDF_SCALE / 2 },
			{ page: 1, zoom: Number.NaN },
		]) {
			expect(parsePdfPosition(bad)).toBeNull();
		}
	});
});

describe("clampPdfPosition", () => {
	it("keeps a page that still exists", () => {
		const p = { page: 4, zoom: 1 };
		expect(clampPdfPosition(p, 10)).toBe(p);
	});

	it("lands on the last page of a shorter document", () => {
		expect(clampPdfPosition({ page: 9, zoom: 2 }, 3)).toEqual({
			page: 3,
			zoom: 2,
		});
	});

	it("never goes below page 1, even for an empty document", () => {
		expect(clampPdfPosition({ page: 5, zoom: 1 }, 0).page).toBe(1);
	});
});

describe("stepPdfZoom", () => {
	it("steps to the next scale either way", () => {
		expect(stepPdfZoom(1, 1)).toBe(1.1);
		expect(stepPdfZoom(1, -1)).toBe(0.9);
		expect(stepPdfZoom(1.2, 1)).toBe(1.25);
		expect(stepPdfZoom(1.2, -1)).toBe(1.1);
	});

	it("treats a near miss as on the step", () => {
		expect(stepPdfZoom(0.9999, 1)).toBe(1.1);
	});

	it("stops at the ends", () => {
		expect(stepPdfZoom(MAX_PDF_SCALE, 1)).toBe(MAX_PDF_SCALE);
		expect(stepPdfZoom(MIN_PDF_SCALE, -1)).toBe(MIN_PDF_SCALE);
	});
});

describe("classifyPdfLink", () => {
	it("leaves in-document links to pdf.js", () => {
		expect(classifyPdfLink("#page=3")).toEqual({ kind: "internal" });
	});

	it("opens web and mail links outside", () => {
		expect(classifyPdfLink("https://example.com/a")).toEqual({
			kind: "external",
			url: "https://example.com/a",
		});
		expect(classifyPdfLink("HTTP://x.y")).toEqual({
			kind: "external",
			url: "HTTP://x.y",
		});
		expect(classifyPdfLink("mailto:a@b.c").kind).toBe("external");
	});

	it("ignores every other link", () => {
		for (const href of [
			null,
			"",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"other.pdf",
			"vscode://file/x",
		]) {
			expect(classifyPdfLink(href)).toEqual({ kind: "ignore" });
		}
	});
});

describe("labels and paths", () => {
	it("names a zoom", () => {
		expect(pdfZoomLabel("page-width")).toBe("Fit width");
		expect(pdfZoomLabel(1.25)).toBe("125%");
	});

	it("spots a PDF by extension", () => {
		expect(isPdfPath("/a/Spec.PDF")).toBe(true);
		expect(isPdfPath("/a/pdf.txt")).toBe(false);
	});
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pdf.js cannot run in jsdom: a fake viewer stands in, recording what the
// component asks of it and letting the test fire pdf.js's events.

type Handler = (e: unknown) => void;

class FakeEventBus {
	handlers = new Map<string, Handler[]>();
	dispatched: { name: string; data: unknown }[] = [];
	on(name: string, fn: Handler) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
	}
	off(name: string, fn: Handler) {
		this.handlers.set(
			name,
			(this.handlers.get(name) ?? []).filter((h) => h !== fn),
		);
	}
	dispatch(name: string, data: unknown) {
		this.dispatched.push({ name, data });
		for (const fn of this.handlers.get(name) ?? []) fn(data);
	}
}

class FakeViewer {
	pagesCount = 0;
	currentPageNumber = 1;
	currentScale = 1;
	currentScaleValue = "auto";
	doc: { numPages: number } | null = null;
	setDocument(doc: { numPages: number }) {
		this.doc = doc;
		this.pagesCount = doc.numPages;
	}
	cleanup() {}
}

const state: {
	bus: FakeEventBus | null;
	viewer: FakeViewer | null;
	docs: { numPages: number; destroyed: boolean }[];
	failNext: boolean;
} = { bus: null, viewer: null, docs: [], failNext: false };

vi.mock("../../../lib/pdfjs", () => ({
	PDF_DATA_URLS: {},
	loadPdfjs: async () => ({
		lib: {
			getDocument: () => {
				const fail = state.failNext;
				state.failNext = false;
				const doc = {
					numPages: 5,
					destroyed: false,
					destroy() {
						this.destroyed = true;
					},
					getOutline: async () => null,
				};
				return {
					promise: fail
						? Promise.reject(new Error("bad xref"))
						: Promise.resolve(doc).then((d) => {
								state.docs.push(d);
								return d;
							}),
					destroy() {},
				};
			},
		},
		viewer: {
			EventBus: class extends FakeEventBus {
				constructor() {
					super();
					state.bus = this;
				}
			},
			PDFLinkService: class {
				setViewer() {}
				setDocument() {}
				goToDestination() {}
			},
			PDFFindController: class {},
			PDFViewer: class extends FakeViewer {
				constructor() {
					super();
					state.viewer = this;
				}
			},
		},
	}),
}));

const openExternal = vi.fn(async (_url: string) => {});
vi.mock("../../../lib/desktop", () => ({
	openExternal: (url: string) => openExternal(url),
}));

import { PdfView } from "../PdfView";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function flush() {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function render(props: Partial<Parameters<typeof PdfView>[0]> = {}) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const el = (content: string) => (
		<PdfView
			content={content}
			findOpen={false}
			onOpenFind={() => {}}
			onCloseFind={() => {}}
			{...props}
		/>
	);
	await act(async () => root?.render(el("AAAA")));
	await flush();
	return {
		rerender: async (content: string) => {
			await act(async () => root?.render(el(content)));
			await flush();
		},
	};
}

beforeEach(() => {
	state.bus = null;
	state.viewer = null;
	state.docs = [];
	state.failNext = false;
	globalThis.ResizeObserver ??= class {
		observe() {}
		disconnect() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	openExternal.mockClear();
	vi.useRealTimers();
});

describe("PdfView", () => {
	it("opens at the stored page and zoom", async () => {
		await render({ position: { page: 3, zoom: 1.5 } });
		act(() => state.bus?.dispatch("pagesinit", {}));
		expect(state.viewer?.currentScaleValue).toBe("1.5");
		expect(state.viewer?.currentPageNumber).toBe(3);
	});

	it("clamps a stored page past the end", async () => {
		await render({ position: { page: 40, zoom: "page-width" } });
		act(() => state.bus?.dispatch("pagesinit", {}));
		expect(state.viewer?.currentPageNumber).toBe(5);
		expect(state.viewer?.currentScaleValue).toBe("page-width");
	});

	it("reports where the user went, once they stop", async () => {
		const onPositionChange = vi.fn();
		await render({ onPositionChange });
		vi.useFakeTimers();
		act(() => {
			state.bus?.dispatch("pagechanging", { pageNumber: 2 });
			state.bus?.dispatch("pagechanging", { pageNumber: 4 });
			state.bus?.dispatch("scalechanging", { scale: 2 });
		});
		expect(onPositionChange).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(2000));
		expect(onPositionChange).toHaveBeenCalledTimes(1);
		expect(onPositionChange).toHaveBeenCalledWith({ page: 4, zoom: 2 });
	});

	it("keeps page and zoom across a reload, and keeps the last good document when one fails", async () => {
		const { rerender } = await render({ position: { page: 1, zoom: 1 } });
		act(() => {
			state.bus?.dispatch("pagechanging", { pageNumber: 4 });
		});
		await rerender("BBBB");
		expect(state.docs).toHaveLength(2);
		expect(state.docs[0].destroyed).toBe(true);
		act(() => state.bus?.dispatch("pagesinit", {}));
		expect(state.viewer?.currentPageNumber).toBe(4);

		state.failNext = true;
		await rerender("CCCC");
		expect(state.viewer?.doc).toBe(state.docs[1]);
		expect(host?.textContent).not.toContain("could not be shown");
	});

	it("opens web links in the browser and drops other links", async () => {
		await render();
		const viewerEl = host?.querySelector(".pdfViewer") as HTMLElement;
		const link = (href: string) => {
			const a = document.createElement("a");
			a.setAttribute("href", href);
			viewerEl.appendChild(a);
			const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
			a.dispatchEvent(ev);
			return ev.defaultPrevented;
		};
		expect(link("https://example.com")).toBe(true);
		expect(openExternal).toHaveBeenCalledWith("https://example.com");
		expect(link("file:///etc/passwd")).toBe(true);
		expect(link("javascript:alert(1)")).toBe(true);
		expect(openExternal).toHaveBeenCalledTimes(1);
		// In-document links are pdf.js's own.
		expect(link("#page=2")).toBe(false);
	});

	it("searches through pdf.js's find controller", async () => {
		await act(async () => {});
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<PdfView
					content="AAAA"
					findOpen
					onOpenFind={() => {}}
					onCloseFind={() => {}}
				/>,
			),
		);
		await flush();
		const input = host.querySelector(
			'input[aria-label="Find in document"]',
		) as HTMLInputElement;
		expect(input).toBeTruthy();
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		act(() => {
			setValue?.call(input, "needle");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const find = state.bus?.dispatched.find((d) => d.name === "find");
		expect(find?.data).toMatchObject({ query: "needle", type: "" });
	});
});

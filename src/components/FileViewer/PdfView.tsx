import {
	ChevronDown,
	ChevronUp,
	ListTree,
	Minus,
	MoveHorizontal,
	Plus,
	Printer,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { decodeBase64 } from "../../lib/base64";
import { openExternal } from "../../lib/desktop";
import { loadPdfjs, PDF_DATA_URLS } from "../../lib/pdfjs";
import { PrintCancelled, printPdf } from "../../lib/pdfPrint";
import {
	clampPdfPosition,
	classifyPdfLink,
	DEFAULT_PDF_POSITION,
	type PdfPosition,
	type PdfZoom,
	pdfZoomLabel,
	pinchScaleFactor,
	samePdfPosition,
	stepPdfZoom,
} from "../../lib/pdfView";

interface Props {
	/** The file's bytes, base64. A new value is a reload: page and zoom stay. */
	content: string;
	/** Where to open; absent or `null`: the first page at fit width. */
	position?: PdfPosition | null;
	/** Told where the view is after the user scrolls or zooms (debounced). */
	onPositionChange?: (position: PdfPosition) => void;
	findOpen: boolean;
	onOpenFind: () => void;
	onCloseFind: () => void;
	/** The pane is focused: the document takes keyboard focus, to scroll. */
	focused?: boolean;
}

/** An outline entry, as pdf.js gives it. */
interface OutlineItem {
	title: string;
	dest: string | unknown[] | null;
	url: string | null;
	items: OutlineItem[];
}

// biome-ignore lint/suspicious/noExplicitAny: pdf.js's viewer classes are loaded at run time
type Any = any;

// Saving the position rewrites the layout, so wait until the user has
// settled rather than saving while they scroll.
const POSITION_REPORT_MS = 1200;
// How long a pinch shows the CSS-scaled pages before drawing them sharp.
const PINCH_DRAW_DELAY_MS = 400;

const buttonClass =
	"flex items-center justify-center rounded cursor-pointer border-0 bg-transparent " +
	"text-[var(--fg-secondary)] enabled:hover:bg-[var(--bg-tertiary)] enabled:hover:text-[var(--fg-primary)] " +
	"disabled:opacity-40 disabled:cursor-default";
const pressedClass = "bg-[var(--bg-tertiary)] text-[var(--fg-primary)]";

/**
 * A read-only PDF, drawn by pdf.js (docs/plans/pdf-viewer.md). Pages stay
 * white whatever the theme; text can be selected and copied; links to pages
 * jump, web links open in the browser, other links do nothing.
 */
export function PdfView({
	content,
	position,
	onPositionChange,
	findOpen,
	onOpenFind,
	onCloseFind,
	focused = false,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewerElRef = useRef<HTMLDivElement>(null);
	const viewerRef = useRef<Any>(null);
	const linkServiceRef = useRef<Any>(null);
	const eventBusRef = useRef<Any>(null);
	const docRef = useRef<Any>(null);

	// The live position: the one to keep across a reload. Starts from the
	// stored one; the prop is only read again for a new mount.
	const livePosition = useRef<PdfPosition>(position ?? DEFAULT_PDF_POSITION);
	const reported = useRef<PdfPosition>(livePosition.current);
	const onPositionChangeRef = useRef(onPositionChange);
	onPositionChangeRef.current = onPositionChange;

	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pageCount, setPageCount] = useState(0);
	const [page, setPage] = useState(livePosition.current.page);
	const [zoom, setZoom] = useState<PdfZoom>(livePosition.current.zoom);
	const [scale, setScale] = useState(1);
	const [outline, setOutline] = useState<OutlineItem[]>([]);
	const [outlineOpen, setOutlineOpen] = useState(false);
	// Pages drawn so far while preparing a print; `null` when not printing.
	const [printing, setPrinting] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const printAbort = useRef<AbortController | null>(null);
	const print = useCallback(() => {
		const doc = docRef.current;
		if (!doc || printAbort.current) return;
		const abort = new AbortController();
		printAbort.current = abort;
		setPrinting({ done: 0, total: doc.numPages });
		printPdf(doc, {
			signal: abort.signal,
			onProgress: (done, total) => setPrinting({ done, total }),
		})
			.catch((e) => {
				if (!(e instanceof PrintCancelled)) {
					console.error("[pdf] print failed:", e);
				}
			})
			.finally(() => {
				printAbort.current = null;
				setPrinting(null);
			});
	}, []);
	// Unmounting mid-print stops drawing.
	useEffect(() => () => printAbort.current?.abort(), []);

	// Report the position once the user stops moving.
	const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scheduleReport = useCallback(() => {
		if (reportTimer.current) clearTimeout(reportTimer.current);
		reportTimer.current = setTimeout(() => {
			reportTimer.current = null;
			const now = livePosition.current;
			if (samePdfPosition(now, reported.current)) return;
			reported.current = now;
			onPositionChangeRef.current?.(now);
		}, POSITION_REPORT_MS);
	}, []);
	useEffect(
		() => () => {
			// Unmounting: report a pending move now, or it is lost.
			if (!reportTimer.current) return;
			clearTimeout(reportTimer.current);
			const now = livePosition.current;
			if (!samePdfPosition(now, reported.current)) {
				onPositionChangeRef.current?.(now);
			}
		},
		[],
	);

	// One viewer per mount.
	useEffect(() => {
		let cancelled = false;
		loadPdfjs()
			.then(({ viewer: pv }) => {
				const container = containerRef.current;
				const viewerEl = viewerElRef.current;
				if (cancelled || !container || !viewerEl) return;
				const eventBus = new pv.EventBus();
				const linkService = new pv.PDFLinkService({ eventBus });
				const findController = new pv.PDFFindController({
					eventBus,
					linkService,
				});
				const viewer = new pv.PDFViewer({
					container,
					viewer: viewerEl,
					eventBus,
					linkService,
					findController,
					// Forms and scripts are off: the view is read-only.
					annotationMode: 1, // AnnotationMode.ENABLE
					annotationEditorMode: -1, // AnnotationEditorType.DISABLE
				});
				linkService.setViewer(viewer);
				eventBus.on("pagechanging", (e: { pageNumber: number }) => {
					setPage(e.pageNumber);
					livePosition.current = {
						...livePosition.current,
						page: e.pageNumber,
					};
					scheduleReport();
				});
				eventBus.on(
					"scalechanging",
					(e: { scale: number; presetValue?: string }) => {
						const z: PdfZoom =
							e.presetValue === "page-width" ? "page-width" : e.scale;
						setScale(e.scale);
						setZoom(z);
						livePosition.current = { ...livePosition.current, zoom: z };
						scheduleReport();
					},
				);
				eventBus.on("pagesinit", () => {
					const p = clampPdfPosition(livePosition.current, viewer.pagesCount);
					viewer.currentScaleValue =
						p.zoom === "page-width" ? "page-width" : String(p.zoom);
					viewer.currentPageNumber = p.page;
					livePosition.current = p;
				});
				viewerRef.current = viewer;
				linkServiceRef.current = linkService;
				eventBusRef.current = eventBus;
				setReady(true);
			})
			.catch((e) => {
				if (!cancelled) setError(`The PDF viewer could not load. ${e}`);
			});
		return () => {
			cancelled = true;
			viewerRef.current?.cleanup?.();
			docRef.current?.destroy?.();
			docRef.current = null;
			viewerRef.current = null;
		};
	}, [scheduleReport]);

	// Load (and reload) the document.
	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		let task: Any = null;
		(async () => {
			const { lib } = await loadPdfjs();
			task = lib.getDocument({
				data: decodeBase64(content),
				...PDF_DATA_URLS,
				enableXfa: false,
				// Draw on the GPU.
				enableHWA: true,
			});
			const doc = await task.promise;
			if (cancelled) {
				doc.destroy();
				return;
			}
			const viewer = viewerRef.current;
			if (!viewer) return;
			const previous = docRef.current;
			docRef.current = doc;
			viewer.setDocument(doc);
			linkServiceRef.current.setDocument(doc, null);
			previous?.destroy();
			setPageCount(doc.numPages);
			setError(null);
			const items = (await doc.getOutline()) as OutlineItem[] | null;
			if (!cancelled) setOutline(items ?? []);
		})().catch((e) => {
			if (cancelled) return;
			// A file half way through being written: keep the last good
			// document; the next change tries again.
			if (!docRef.current) setError(`It could not be read as a PDF. ${e}`);
		});
		return () => {
			cancelled = true;
			task?.destroy?.();
		};
	}, [ready, content]);

	// Fit width follows the pane's width.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Only a change of width refits: a height change (a find bar, a
		// banner) would otherwise redraw every visible page.
		let width = container.clientWidth;
		const observer = new ResizeObserver(() => {
			if (container.clientWidth === width) return;
			width = container.clientWidth;
			const viewer = viewerRef.current;
			if (viewer?.pagesCount && livePosition.current.zoom === "page-width") {
				viewer.currentScaleValue = "page-width";
			}
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (focused && !findOpen) {
			containerRef.current?.focus({ preventScroll: true });
		}
	}, [focused, findOpen]);

	const setZoomTo = useCallback((z: PdfZoom) => {
		const viewer = viewerRef.current;
		if (!viewer?.pagesCount) return;
		viewer.currentScaleValue = z === "page-width" ? "page-width" : String(z);
	}, []);
	const zoomBy = useCallback(
		(direction: 1 | -1) => {
			const viewer = viewerRef.current;
			if (!viewer?.pagesCount) return;
			setZoomTo(stepPdfZoom(viewer.currentScale, direction));
		},
		[setZoomTo],
	);
	const goToPage = useCallback((n: number) => {
		const viewer = viewerRef.current;
		if (!viewer?.pagesCount) return;
		viewer.currentPageNumber = Math.min(Math.max(1, n), viewer.pagesCount);
	}, []);

	// Pinch, or Cmd/Ctrl + wheel, zooms instead of scrolling.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			const viewer = viewerRef.current;
			if (!viewer?.pagesCount) return;
			const factor = pinchScaleFactor(viewer.currentScale, e.deltaY);
			if (factor === 1) return;
			const rect = container.getBoundingClientRect();
			// Scales the drawn pages with CSS at once, and draws them sharp
			// only once the gesture pauses.
			viewer.updateScale({
				scaleFactor: factor,
				origin: [e.clientX - rect.left, e.clientY - rect.top],
				drawingDelay: PINCH_DRAW_DELAY_MS,
			});
		};
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => container.removeEventListener("wheel", onWheel);
	}, []);

	// A link in the page: in-document ones are pdf.js's own; web links go to
	// the browser; anything else would navigate the whole webview, so stop it.
	const onClickCapture = useCallback((e: React.MouseEvent) => {
		const anchor = (e.target as HTMLElement).closest?.("a");
		if (!anchor) return;
		const action = classifyPdfLink(anchor.getAttribute("href"));
		if (action.kind === "internal") return;
		e.preventDefault();
		e.stopPropagation();
		if (action.kind === "external") openExternal(action.url).catch(() => {});
	}, []);

	const openOutlineItem = useCallback((item: OutlineItem) => {
		if (item.dest) {
			linkServiceRef.current?.goToDestination(item.dest);
			return;
		}
		const action = classifyPdfLink(item.url);
		if (action.kind === "external") openExternal(action.url).catch(() => {});
	}, []);

	const [pageInput, setPageInput] = useState(String(page));
	useEffect(() => setPageInput(String(page)), [page]);

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div
				className="flex items-center gap-1 shrink-0"
				style={{
					height: 30,
					padding: "0 8px",
					borderBottom:
						"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
					fontSize: 12,
					color: "var(--fg-secondary)",
				}}
			>
				{outline.length > 0 && (
					<button
						type="button"
						aria-label="Outline"
						title="Outline"
						aria-pressed={outlineOpen}
						onClick={() => setOutlineOpen((o) => !o)}
						className={`${buttonClass} ${outlineOpen ? pressedClass : ""}`}
						style={{ width: 24, height: 22, padding: 0 }}
					>
						<ListTree size={14} />
					</button>
				)}
				<form
					className="flex items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						const n = Number.parseInt(pageInput, 10);
						if (Number.isFinite(n)) goToPage(n);
						else setPageInput(String(page));
					}}
				>
					<input
						value={pageInput}
						onChange={(e) => setPageInput(e.target.value)}
						onBlur={() => setPageInput(String(page))}
						aria-label="Page"
						inputMode="numeric"
						className="bg-[var(--bg-primary)] text-[var(--fg-primary)] outline-none rounded text-right"
						style={{
							width: 40,
							height: 20,
							padding: "0 4px",
							border: "1px solid var(--border)",
							fontSize: 12,
						}}
					/>
					<span>/ {pageCount || "–"}</span>
				</form>
				<div style={{ flex: 1 }} />
				<button
					type="button"
					aria-label="Zoom out"
					title="Zoom out"
					disabled={!pageCount}
					onClick={() => zoomBy(-1)}
					className={buttonClass}
					style={{ width: 24, height: 22, padding: 0 }}
				>
					<Minus size={14} />
				</button>
				<span style={{ minWidth: 64, textAlign: "center" }}>
					{zoom === "page-width"
						? `${pdfZoomLabel("page-width")} · ${pdfZoomLabel(scale)}`
						: pdfZoomLabel(zoom)}
				</span>
				<button
					type="button"
					aria-label="Zoom in"
					title="Zoom in"
					disabled={!pageCount}
					onClick={() => zoomBy(1)}
					className={buttonClass}
					style={{ width: 24, height: 22, padding: 0 }}
				>
					<Plus size={14} />
				</button>
				<button
					type="button"
					aria-label="Fit width"
					title="Fit width"
					aria-pressed={zoom === "page-width"}
					disabled={!pageCount}
					onClick={() => setZoomTo("page-width")}
					className={`${buttonClass} ${zoom === "page-width" ? pressedClass : ""}`}
					style={{ width: 24, height: 22, padding: 0 }}
				>
					<MoveHorizontal size={14} />
				</button>
				<button
					type="button"
					aria-label="Find"
					title="Find"
					disabled={!pageCount}
					onClick={() => (findOpen ? onCloseFind() : onOpenFind())}
					className={`${buttonClass} ${findOpen ? pressedClass : ""}`}
					style={{ width: 24, height: 22, padding: 0 }}
				>
					<Search size={14} />
				</button>
				<button
					type="button"
					aria-label="Print"
					title="Print…"
					disabled={!pageCount || printing !== null}
					onClick={print}
					className={buttonClass}
					style={{ width: 24, height: 22, padding: 0 }}
				>
					<Printer size={14} />
				</button>
			</div>
			<div className="flex-1 min-h-0 flex">
				{outlineOpen && outline.length > 0 && (
					<nav
						aria-label="Outline"
						className="shrink-0 overflow-auto"
						style={{
							width: 220,
							padding: "6px 0",
							borderRight:
								"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
							fontSize: 12,
						}}
					>
						<OutlineList items={outline} depth={0} onOpen={openOutlineItem} />
					</nav>
				)}
				<div className="relative flex-1 min-w-0">
					{findOpen && eventBusRef.current && (
						<PdfFindBar eventBus={eventBusRef.current} onClose={onCloseFind} />
					)}
					{printing && (
						<div
							className="absolute flex items-center gap-2"
							style={{
								top: 8,
								left: "50%",
								transform: "translateX(-50%)",
								zIndex: 11,
								padding: "6px 6px 6px 12px",
								borderRadius: 6,
								fontSize: 12,
								color: "var(--fg-primary)",
								background: "var(--bg-secondary)",
								border: "1px solid var(--border)",
								boxShadow:
									"0 4px 14px color-mix(in srgb, var(--bg-primary) 60%, transparent)",
							}}
							role="status"
						>
							Preparing page {Math.min(printing.done + 1, printing.total)} of{" "}
							{printing.total}…
							<button
								type="button"
								onClick={() => printAbort.current?.abort()}
								className={buttonClass}
								style={{ height: 22, padding: "0 8px", fontSize: 12 }}
							>
								Cancel
							</button>
						</div>
					)}
					{error && (
						<div
							className="absolute inset-0 flex items-center justify-center"
							style={{
								padding: 24,
								color: "var(--fg-secondary)",
								fontSize: 13,
								textAlign: "center",
								zIndex: 1,
							}}
						>
							This PDF could not be shown. {error}
						</div>
					)}
					{/* pdf.js needs its container absolutely positioned. */}
					<div
						ref={containerRef}
						tabIndex={-1}
						onClickCapture={onClickCapture}
						className="absolute inset-0 overflow-auto outline-none abundio-pdf"
						style={{ background: "var(--bg-primary)" }}
					>
						<div ref={viewerElRef} className="pdfViewer" />
					</div>
				</div>
			</div>
		</div>
	);
}

function OutlineList({
	items,
	depth,
	onOpen,
}: {
	items: OutlineItem[];
	depth: number;
	onOpen: (item: OutlineItem) => void;
}) {
	return (
		<ul style={{ listStyle: "none" }}>
			{items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: outline entries have no ids and never reorder
				<li key={i}>
					<button
						type="button"
						onClick={() => onOpen(item)}
						title={item.title}
						className="w-full text-left truncate cursor-pointer border-0 bg-transparent text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
						style={{ padding: `3px 8px 3px ${10 + depth * 12}px` }}
					>
						{item.title}
					</button>
					{item.items.length > 0 && (
						<OutlineList items={item.items} depth={depth + 1} onOpen={onOpen} />
					)}
				</li>
			))}
		</ul>
	);
}

/** Find in the document, through pdf.js's find controller. */
function PdfFindBar({
	eventBus,
	onClose,
}: {
	eventBus: Any;
	onClose: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [matches, setMatches] = useState<{ current: number; total: number }>({
		current: 0,
		total: 0,
	});
	const [notFound, setNotFound] = useState(false);

	useEscapeKey(onClose);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
		const onCount = (e: { matchesCount: { current: number; total: number } }) =>
			setMatches(e.matchesCount);
		const onState = (e: {
			state: number;
			matchesCount?: { current: number; total: number };
		}) => {
			setNotFound(e.state === 1); // FindState.NOT_FOUND
			if (e.matchesCount) setMatches(e.matchesCount);
		};
		eventBus.on("updatefindmatchescount", onCount);
		eventBus.on("updatefindcontrolstate", onState);
		return () => {
			eventBus.off("updatefindmatchescount", onCount);
			eventBus.off("updatefindcontrolstate", onState);
			eventBus.dispatch("findbarclose", { source: null });
		};
	}, [eventBus]);

	const find = useCallback(
		(q: string, type: "" | "again", findPrevious = false) => {
			eventBus.dispatch("find", {
				source: null,
				type,
				query: q,
				caseSensitive: false,
				entireWord: false,
				highlightAll: true,
				findPrevious,
				matchDiacritics: false,
			});
		},
		[eventBus],
	);

	const count =
		query === ""
			? ""
			: notFound || matches.total === 0
				? "No results"
				: `${matches.current} of ${matches.total}`;

	return (
		<div
			className="absolute flex items-center gap-1"
			style={{
				top: 8,
				right: 16,
				zIndex: 10,
				padding: "4px 4px 4px 8px",
				borderRadius: 6,
				background: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				boxShadow:
					"0 4px 14px color-mix(in srgb, var(--bg-primary) 60%, transparent)",
			}}
		>
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					find(e.target.value, "");
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (query) find(query, "again", e.shiftKey);
					}
				}}
				placeholder="Find"
				aria-label="Find in document"
				className="bg-transparent outline-none border-0 text-[var(--fg-primary)]"
				style={{ width: 180, fontSize: 12, padding: 0 }}
			/>
			<span
				aria-live="polite"
				style={{
					fontSize: 11,
					color: "var(--fg-secondary)",
					minWidth: 64,
					textAlign: "right",
					whiteSpace: "nowrap",
				}}
			>
				{count}
			</span>
			<button
				type="button"
				aria-label="Previous match"
				title="Previous match (Shift+Enter)"
				disabled={matches.total === 0}
				onClick={() => find(query, "again", true)}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<ChevronUp size={14} />
			</button>
			<button
				type="button"
				aria-label="Next match"
				title="Next match (Enter)"
				disabled={matches.total === 0}
				onClick={() => find(query, "again")}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<ChevronDown size={14} />
			</button>
			<button
				type="button"
				aria-label="Close find"
				title="Close (Escape)"
				onClick={onClose}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<X size={14} />
			</button>
		</div>
	);
}

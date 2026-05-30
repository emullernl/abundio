import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import "./PreviewPane.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import rehypeSanitize from "rehype-sanitize";
import { useSplitPane } from "../../hooks/useSplitPane";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import {
	consumePendingPrint,
	registerPreviewPrinter,
	unregisterPreviewPrinter,
} from "../../lib/markdownPreviewPrint";
import { printMarkdownPreview } from "../../lib/markdownPrint";
import { markdownSanitizeSchema } from "../../lib/markdownSanitizeSchema";
import { rehypeSourceLines } from "../../lib/rehypeSourceLines";
import {
	registerSyncPreview,
	unregisterSyncPreview,
} from "../../lib/scrollSync";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { makeMarkdownImageComponent } from "./MarkdownImage";
import { makeMarkdownCodeComponent } from "./MermaidCode";
import { PreviewPaneTitleBar } from "./PreviewPaneTitleBar";

// Base editor font size — the preview zoom is computed relative to this so
// Cmd+= / Cmd+- scales the preview alongside the Monaco editor.
const BASE_FONT_SIZE = 14;

// Re-rendering the markdown (parse + Mermaid) on every keystroke lags the
// editor, so the preview only re-renders after a typing pause.
const RENDER_DEBOUNCE_MS = 250;

// `rehypeSourceLines` stamps `data-source-line` anchors for editor↔preview
// sync. `rehypeSanitize` strips dangerous raw HTML (@uiw bakes in `rehype-raw`
// with no sanitizer) — it must run after both `rehype-raw` and
// `rehypeSourceLines`, which it does: @uiw appends `props.rehypePlugins` after
// its own `rehype-raw`, and the array order is preserved within that.
const REHYPE_PLUGINS = [
	rehypeSourceLines,
	[rehypeSanitize, markdownSanitizeSchema] as [
		typeof rehypeSanitize,
		typeof markdownSanitizeSchema,
	],
];

interface PreviewPaneProps {
	paneId: string;
	sourcePaneId: string;
	isFocused: boolean;
	onFocus: () => void;
}

export function PreviewPane({
	paneId,
	sourcePaneId,
	isFocused,
	onFocus,
}: PreviewPaneProps) {
	const sourceState = useExplorerStore((s) => s.filePanes[sourcePaneId]);
	// Shares the editor's font-size setting (driven by Cmd+= / Cmd+-).
	const fontSize = useSettingsStore((s) => s.fontSize);
	const zoom = fontSize / BASE_FONT_SIZE;

	const { splitPaneWithPicker, closePane } = useSplitPane();
	const contentRef = useRef<HTMLDivElement>(null);

	const content = sourceState?.content ?? "";
	const sourceName = sourceState?.fileName ?? "";
	const sourceIsMarkdown = sourceName ? isMarkdownFile(sourceName) : true;

	// Directory of the source markdown file — relative image srcs resolve
	// against it so local images can be read off disk and inlined.
	const baseDir = (sourceState?.filePath ?? "").replace(/\/[^/]*$/, "");

	// Debounced copy of the source buffer — what actually feeds the renderer.
	const [renderedContent, setRenderedContent] = useState(content);
	useEffect(() => {
		const t = setTimeout(() => setRenderedContent(content), RENDER_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [content]);

	// The preview always renders light — a "printed paper" look — regardless of
	// the app theme.
	const components = useMemo(
		() => ({
			code: makeMarkdownCodeComponent(),
			img: makeMarkdownImageComponent(baseDir),
		}),
		[baseDir],
	);

	// react-markdown does NO internal memoization — every render re-parses the
	// whole document and re-runs every rehype plugin. PreviewPane re-renders on
	// each keystroke (the source pane's store entry changes), so the rendered
	// element is memoized here: between debounce flushes React reuses it and
	// skips the parse entirely.
	const preview = useMemo(
		() =>
			sourceIsMarkdown ? (
				<MarkdownPreview
					source={renderedContent}
					components={components}
					rehypePlugins={REHYPE_PLUGINS}
					style={{ zoom }}
				/>
			) : null,
		[sourceIsMarkdown, renderedContent, components, zoom],
	);

	const doPrint = useCallback(() => {
		if (contentRef.current) printMarkdownPreview(contentRef.current);
	}, []);

	// Expose printing to the source file pane's "Print" menu item, which may
	// open this preview specifically in order to print it.
	useEffect(() => {
		registerPreviewPrinter(sourcePaneId, doPrint);
		return () => unregisterPreviewPrinter(sourcePaneId);
	}, [sourcePaneId, doPrint]);

	// If a print was requested before this pane mounted, run it once the
	// (debounced) content is on screen — give Mermaid a beat to settle first.
	useEffect(() => {
		if (!renderedContent || !consumePendingPrint(sourcePaneId)) return;
		const t = setTimeout(doPrint, 200);
		return () => clearTimeout(t);
	}, [renderedContent, sourcePaneId, doPrint]);

	// Link this preview's scroll container to its source editor for scroll sync.
	useEffect(() => {
		const el = contentRef.current;
		if (!el) return;
		registerSyncPreview(sourcePaneId, el);
		return () => unregisterSyncPreview(sourcePaneId);
	}, [sourcePaneId]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on pane container
		// biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus on pane container
		<div
			className="relative w-full h-full flex flex-col"
			data-pane-id={paneId}
			style={{
				backgroundColor: "var(--bg-primary)",
				outline: isFocused
					? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
					: "none",
				outlineOffset: -1,
			}}
			onClick={onFocus}
		>
			<PreviewPaneTitleBar
				paneId={paneId}
				sourceName={sourceName}
				onPrint={doPrint}
				onSplitDown={() => splitPaneWithPicker(paneId, "horizontal")}
				onSplitRight={() => splitPaneWithPicker(paneId, "vertical")}
				onClose={() => closePane(paneId)}
			/>
			{/* The whole scroll area is white so the padding around the rendered
			    document matches the document's own canvas. */}
			<div
				ref={contentRef}
				className="flex-1 min-h-0 overflow-auto abundio-md-preview"
				data-color-mode="light"
				style={{ padding: "28px 36px", background: "#ffffff" }}
			>
				{preview}
			</div>
		</div>
	);
}

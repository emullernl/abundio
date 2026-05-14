import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import {
	consumePendingPrint,
	registerPreviewPrinter,
	unregisterPreviewPrinter,
} from "../../lib/markdownPreviewPrint";
import { printMarkdownPreview } from "../../lib/markdownPrint";
import { useExplorerStore } from "../../stores/explorerStore";
import { makeMarkdownCodeComponent } from "./MermaidCode";
import { PreviewPaneTitleBar } from "./PreviewPaneTitleBar";

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

	const { splitPaneWithPicker, closePane } = useSplitPane();
	const contentRef = useRef<HTMLDivElement>(null);

	const content = sourceState?.content ?? "";
	const sourceName = sourceState?.fileName ?? "";
	const sourceIsMarkdown = sourceName ? isMarkdownFile(sourceName) : true;

	// The preview always renders light — a "printed paper" look — regardless of
	// the app theme.
	const components = useMemo(() => ({ code: makeMarkdownCodeComponent() }), []);

	const doPrint = useCallback(() => {
		if (contentRef.current) printMarkdownPreview(contentRef.current);
	}, []);

	// Expose printing to the source file pane's "Print" menu item, which may
	// open this preview specifically in order to print it.
	useEffect(() => {
		registerPreviewPrinter(sourcePaneId, doPrint);
		return () => unregisterPreviewPrinter(sourcePaneId);
	}, [sourcePaneId, doPrint]);

	// If a print was requested before this pane mounted, run it once content
	// is on screen (give Mermaid a beat to settle first).
	useEffect(() => {
		if (!content || !consumePendingPrint(sourcePaneId)) return;
		const t = setTimeout(doPrint, 200);
		return () => clearTimeout(t);
	}, [content, sourcePaneId, doPrint]);

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
				{sourceIsMarkdown && (
					<MarkdownPreview source={content} components={components} />
				)}
			</div>
		</div>
	);
}

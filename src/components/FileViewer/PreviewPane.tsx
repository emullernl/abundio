import "./PreviewPane.css";
import { open } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import {
	classifyMarkdownLink,
	scrollToFragment,
} from "../../lib/markdownLinks";
import {
	consumePendingPrint,
	registerPreviewPrinter,
	unregisterPreviewPrinter,
} from "../../lib/markdownPreviewPrint";
import { printMarkdownPreview } from "../../lib/markdownPrint";
import { resolvePreviewColorMode } from "../../lib/previewColorMode";
import {
	registerSyncPreview,
	unregisterSyncPreview,
} from "../../lib/scrollSync";
import { getTheme } from "../../lib/themes";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { MarkdownRendered } from "./MarkdownRendered";
import { PreviewPaneTitleBar } from "./PreviewPaneTitleBar";

// Base editor font size — the preview zoom is computed relative to this so
// Cmd+= / Cmd+- scales the preview alongside the Monaco editor.
const BASE_FONT_SIZE = 14;

// A print requested before this pane mounted waits for the debounced render
// (250ms in MarkdownRendered) plus a beat for Mermaid to settle.
const PENDING_PRINT_DELAY_MS = 450;

interface PreviewPaneProps {
	paneId: string;
	sourcePaneId: string;
	/** Whether this is the Focused pane. Moves real (DOM) focus onto the
	 *  scroll area, so arrow keys scroll the preview and keystrokes stop going
	 *  to the terminal a Pane cycle or Directional move just left. */
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

	// Preview color: "auto" follows the active theme's variant, "light" forces
	// the pure-white "printed paper" look regardless of theme. See ADR-0013.
	const colorMode = useSettingsStore((s) => s.markdownPreviewColorMode);
	const toggleColorMode = useSettingsStore(
		(s) => s.toggleMarkdownPreviewColorMode,
	);
	const themeVariant = useSettingsStore((s) => getTheme(s.theme).variant);
	const resolvedMode = resolvePreviewColorMode(colorMode, themeVariant);
	// In "auto" the preview adopts the app theme's actual colours (canvas, text,
	// borders, links — see PreviewPane.css `[data-themed]` overrides); "light"
	// forces the pure-white "printed paper" look. `resolvedMode` still drives
	// @uiw's base (incl. code-syntax token colours) so a dark theme gets a
	// dark-appropriate base. See ADR-0013.
	const followTheme = colorMode === "auto";

	const { splitPaneWithPicker, closePane } = useSplitPane();
	const contentRef = useRef<HTMLDivElement>(null);

	const content = sourceState?.content ?? "";
	const sourceName = sourceState?.fileName ?? "";
	const sourceIsMarkdown = sourceName ? isMarkdownFile(sourceName) : true;

	// Directory of the source markdown file — relative image srcs resolve
	// against it so local images can be read off disk and inlined.
	const baseDir = (sourceState?.filePath ?? "").replace(/\/[^/]*$/, "");

	const activeWorkspace = useWorkspaceStore((s) =>
		s.workspaces.find((w) => w.id === s.activeWorkspaceId),
	);
	const onLinkClick = useCallback(
		(href: string | undefined) => {
			const action = classifyMarkdownLink(
				href,
				baseDir,
				activeWorkspace?.rootFolder ?? "",
			);
			switch (action.kind) {
				case "fragment":
					if (contentRef.current)
						scrollToFragment(contentRef.current, action.id);
					return;
				case "external":
					open(action.url).catch(() => {});
					return;
				case "workspace-markdown":
					if (activeWorkspace) {
						useExplorerStore
							.getState()
							.openFile(activeWorkspace.id, action.path);
					}
					return;
				default:
					return;
			}
		},
		[baseDir, activeWorkspace],
	);

	const preview = useMemo(
		() =>
			sourceIsMarkdown ? (
				<MarkdownRendered
					content={content}
					baseDir={baseDir}
					resolvedMode={resolvedMode}
					zoom={zoom}
					onLinkClick={onLinkClick}
				/>
			) : null,
		[sourceIsMarkdown, content, baseDir, resolvedMode, zoom, onLinkClick],
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
		if (!content || !consumePendingPrint(sourcePaneId)) return;
		const t = setTimeout(doPrint, PENDING_PRINT_DELAY_MS);
		return () => clearTimeout(t);
	}, [content, sourcePaneId, doPrint]);

	// Link this preview's scroll container to its source editor for scroll sync.
	useEffect(() => {
		const el = contentRef.current;
		if (!el) return;
		registerSyncPreview(sourcePaneId, el);
		return () => unregisterSyncPreview(sourcePaneId);
	}, [sourcePaneId]);

	useEffect(() => {
		if (isFocused) contentRef.current?.focus({ preventScroll: true });
	}, [isFocused]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on pane container
		// biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus on pane container
		<div
			className="relative w-full h-full flex flex-col"
			data-pane-id={paneId}
			style={{
				// In "follow theme" mode the preview is transparent so the workspace
				// ambient gradient shows through; the forced-white "printed paper"
				// mode stays opaque (paper shouldn't be see-through).
				backgroundColor: followTheme ? "transparent" : "var(--bg-primary)",
			}}
			onClick={onFocus}
		>
			<PreviewPaneTitleBar
				paneId={paneId}
				sourceName={sourceName}
				colorMode={colorMode}
				onToggleColorMode={toggleColorMode}
				onPrint={doPrint}
				onSplitDown={() => splitPaneWithPicker(paneId, "horizontal")}
				onSplitRight={() => splitPaneWithPicker(paneId, "vertical")}
				onClose={() => closePane(paneId)}
			/>
			{/* The scroll area's padding matches the document's canvas: the theme's
			    own background when following the theme, pure white for the "printed
			    paper" override. `data-color-mode` drives @uiw's light/dark base;
			    `data-themed` switches on the app-theme colour overrides in
			    PreviewPane.css. */}
			<div
				ref={contentRef}
				// Focusable by script only, so it can hold focus and scroll by key.
				tabIndex={-1}
				className="flex-1 min-h-0 overflow-auto abundio-md-preview outline-none"
				data-color-mode={resolvedMode}
				data-themed={followTheme ? "true" : undefined}
				style={{
					padding: "28px 36px",
					background: followTheme ? "transparent" : "#ffffff",
				}}
			>
				{preview}
			</div>
		</div>
	);
}

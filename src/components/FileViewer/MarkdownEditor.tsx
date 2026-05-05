import "./prismGlobal";
import "@mdxeditor/editor/style.css";
import "./MarkdownEditor.css";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import {
	BlockTypeSelect,
	BoldItalicUnderlineToggles,
	ChangeCodeMirrorLanguage,
	type CodeBlockEditorDescriptor,
	CodeToggle,
	ConditionalContents,
	CreateLink,
	codeBlockPlugin,
	codeMirrorPlugin,
	DiffSourceToggleWrapper,
	diffSourcePlugin,
	frontmatterPlugin,
	headingsPlugin,
	InsertImage,
	InsertTable,
	imagePlugin,
	ListsToggle,
	linkDialogPlugin,
	linkPlugin,
	listsPlugin,
	MDXEditor,
	type MDXEditorMethods,
	markdownShortcutPlugin,
	quotePlugin,
	Separator,
	tablePlugin,
	thematicBreakPlugin,
	toolbarPlugin,
	UndoRedo,
} from "@mdxeditor/editor";
import { Palette, Printer, ZoomIn, ZoomOut } from "lucide-react";
import mermaid from "mermaid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { printMarkdownProse } from "../../lib/markdownPrint";
import { getTheme } from "../../lib/themes";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { MermaidBlock, notifyMermaidThemeChange } from "./MermaidBlock";
import { MarkdownFindBar } from "./MarkdownFindBar";

const sourceViewExtensions = [search({ top: true }), keymap.of(searchKeymap)];

const mermaidDescriptor: CodeBlockEditorDescriptor = {
	priority: 100,
	match: (language) => language === "mermaid",
	Editor: MermaidBlock,
};

const ZOOM_STEP = 10;
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;

// Defined outside the component so toolbarContents can close over stable refs/callbacks
// without causing plugin recreation on every render.
function ZoomButtons({
	zoomRef,
	onZoomIn,
	onZoomOut,
	emitterRef,
}: {
	zoomRef: React.MutableRefObject<number>;
	onZoomIn: () => void;
	onZoomOut: () => void;
	emitterRef: React.MutableRefObject<((pct: number) => void) | null>;
}) {
	const [pct, setPct] = useState(() => Math.round(zoomRef.current * 100));

	// Register so the parent can push display updates (e.g. from keyboard shortcuts)
	useEffect(() => {
		emitterRef.current = setPct;
		return () => {
			emitterRef.current = null;
		};
	}, [emitterRef]);

	return (
		<div className="mdx-zoom-controls">
			<button
				type="button"
				onClick={onZoomOut}
				title="Zoom out"
				className="mdx-zoom-btn"
				disabled={pct <= ZOOM_MIN}
			>
				<ZoomOut size={13} />
			</button>
			<span className="mdx-zoom-label">{pct}%</span>
			<button
				type="button"
				onClick={onZoomIn}
				title="Zoom in"
				className="mdx-zoom-btn"
				disabled={pct >= ZOOM_MAX}
			>
				<ZoomIn size={13} />
			</button>
		</div>
	);
}

function PrintButton({ onPrint }: { onPrint: () => void }) {
	return (
		<button
			type="button"
			onClick={onPrint}
			title="Print"
			className="mdx-zoom-btn"
		>
			<Printer size={13} />
		</button>
	);
}

function ThemeColorsButton({
	enabled,
	onToggle,
}: {
	enabled: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			title={enabled ? "Disable theme colors" : "Enable theme colors"}
			className={`mdx-zoom-btn${enabled ? " mdx-theme-btn--active" : ""}`}
		>
			<Palette size={13} />
		</button>
	);
}

interface MarkdownEditorProps {
	paneId: string;
	isActive: boolean;
	content: string;
	onChange: (md: string) => void;
}

export default function MarkdownEditor({
	paneId,
	isActive: _isActive,
	content,
	onChange,
}: MarkdownEditorProps) {
	const themeName = useSettingsStore((s) => s.theme);
	const savedZoom = useSettingsStore((s) => s.markdownZoom);
	const setMarkdownZoom = useSettingsStore((s) => s.setMarkdownZoom);
	const markdownThemeColors = useSettingsStore((s) => s.markdownThemeColors);
	const toggleMarkdownThemeColors = useSettingsStore(
		(s) => s.toggleMarkdownThemeColors,
	);
	const editorRef = useRef<MDXEditorMethods>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const lastEmittedRef = useRef(content);

	// When the MDX parser fails, fall back to source mode automatically.
	const [parseError, setParseError] = useState(false);
	const parseErrorRef = useRef(false);

	const handleError = useCallback(() => {
		parseErrorRef.current = true;
		setParseError(true);
	}, []);

	const [findOpen, setFindOpen] = useState(false);
	const [zoom, setZoom] = useState(savedZoom);
	const zoomRef = useRef(savedZoom);
	const zoomEmitterRef = useRef<((pct: number) => void) | null>(null);

	const onZoomIn = useCallback(() => {
		const next = Math.min(ZOOM_MAX / 100, zoomRef.current + ZOOM_STEP / 100);
		zoomRef.current = next;
		setZoom(next);
		setMarkdownZoom(next);
		zoomEmitterRef.current?.(Math.round(next * 100));
	}, [setMarkdownZoom]);

	const onZoomOut = useCallback(() => {
		const next = Math.max(ZOOM_MIN / 100, zoomRef.current - ZOOM_STEP / 100);
		zoomRef.current = next;
		setZoom(next);
		setMarkdownZoom(next);
		zoomEmitterRef.current?.(Math.round(next * 100));
	}, [setMarkdownZoom]);

	const handlePrint = useCallback(() => {
		if (wrapperRef.current) {
			const liveTheme =
				getTheme(themeName).variant === "light" ? "default" : "dark";
			printMarkdownProse(wrapperRef.current, liveTheme);
		}
	}, [themeName]);

	useEffect(() => {
		const variant = getTheme(themeName).variant;
		const mermaidTheme =
			markdownThemeColors && variant !== "light" ? "dark" : "default";
		mermaid.initialize({ startOnLoad: false, theme: mermaidTheme });
		notifyMermaidThemeChange();
	}, [themeName, markdownThemeColors]);

	// After zoom CSS updates, nudge CodeMirror scrollers so they re-measure
	// line heights and character widths against the new font size.
	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		requestAnimationFrame(() => {
			for (const scroller of wrapper.querySelectorAll<HTMLElement>(
				".cm-scroller",
			)) {
				const prev = scroller.scrollTop;
				scroller.scrollTop = prev + 1;
				scroller.scrollTop = prev;
			}
		});
	}, [zoom]);

	useEffect(() => {
		if (content !== lastEmittedRef.current) {
			lastEmittedRef.current = content;
			if (parseErrorRef.current) {
				// Content changed while in error/source mode — give it a fresh parse
				// attempt by clearing the error flag; the key change remounts the editor.
				parseErrorRef.current = false;
				setParseError(false);
			} else {
				editorRef.current?.setMarkdown(content);
			}
		}
	}, [content]);

	const handleChange = useCallback(
		(md: string, isInitial: boolean) => {
			if (isInitial) return;
			lastEmittedRef.current = md;
			onChange(md);
		},
		[onChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
				// Let CodeMirror handle Cmd+F in source/diff view
				if (document.activeElement?.closest(".cm-content")) return;
				e.preventDefault();
				setFindOpen(true);
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				useExplorerStore.getState().saveFile(paneId);
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "=") {
				e.preventDefault();
				onZoomIn();
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "-") {
				e.preventDefault();
				onZoomOut();
			}
		},
		[paneId, onZoomIn, onZoomOut, setFindOpen],
	);

	// Plugins are memoized with stable deps so MDXEditor never resets due to zoom changes.
	const plugins = useMemo(
		() => [
			headingsPlugin(),
			listsPlugin(),
			quotePlugin(),
			thematicBreakPlugin(),
			linkPlugin(),
			linkDialogPlugin(),
			imagePlugin(),
			tablePlugin(),
			codeBlockPlugin({ codeBlockEditorDescriptors: [mermaidDescriptor] }),
			codeMirrorPlugin({
				codeBlockLanguages: {
					js: "JavaScript",
					jsx: "JSX",
					ts: "TypeScript",
					tsx: "TSX",
					css: "CSS",
					html: "HTML",
					json: "JSON",
					python: "Python",
					rust: "Rust",
					bash: "Bash",
					sh: "Shell",
					sql: "SQL",
					yaml: "YAML",
					"": "Plain text",
				},
			}),
			frontmatterPlugin(),
			markdownShortcutPlugin(),
			diffSourcePlugin({
				viewMode: parseError ? "source" : "rich-text",
				codeMirrorExtensions: sourceViewExtensions,
			}),
			toolbarPlugin({
				toolbarContents: () => (
					<>
						<DiffSourceToggleWrapper>
							<ConditionalContents
								options={[
									{
										when: (editor) => editor?.editorType === "codeblock",
										contents: () => <ChangeCodeMirrorLanguage />,
									},
									{
										fallback: () => (
											<>
												<UndoRedo />
												<Separator />
												<BlockTypeSelect />
												<Separator />
												<BoldItalicUnderlineToggles />
												<CodeToggle />
												<Separator />
												<ListsToggle />
												<Separator />
												<CreateLink />
												<InsertImage />
												<InsertTable />
												<Separator />
												<PrintButton onPrint={handlePrint} />
												<ThemeColorsButton
													enabled={markdownThemeColors}
													onToggle={toggleMarkdownThemeColors}
												/>
											</>
										),
									},
								]}
							/>
						</DiffSourceToggleWrapper>
						<ZoomButtons
							zoomRef={zoomRef}
							onZoomIn={onZoomIn}
							onZoomOut={onZoomOut}
							emitterRef={zoomEmitterRef}
						/>
					</>
				),
			}),
		],
		[onZoomIn, onZoomOut, handlePrint, parseError],
	);

	return (
		<div
			className={`absolute inset-0${markdownThemeColors ? "" : " md-plain-colors"}`}
			style={{ "--md-zoom": zoom } as React.CSSProperties}
			onKeyDown={handleKeyDown}
		>
			<div
				ref={wrapperRef}
				className="absolute inset-0 overflow-y-auto mdx-page-wrapper"
			>
				<MDXEditor
					ref={editorRef}
					key={`${themeName}-${parseError}`}
					markdown={content}
					onChange={handleChange}
					onError={handleError}
					className="abundio-theme"
					contentEditableClassName="abundio-prose"
					plugins={plugins}
				/>
			</div>
			<MarkdownFindBar
				containerRef={wrapperRef}
				open={findOpen}
				onClose={() => setFindOpen(false)}
			/>
		</div>
	);
}

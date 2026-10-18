import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import "./PreviewPane.css";
import { useEffect, useMemo, useRef, useState } from "react";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import { remarkFrontmatterTable } from "../../lib/markdownFrontmatter";
import { markdownSanitizeSchema } from "../../lib/markdownSanitizeSchema";
import { rehypeSourceLines } from "../../lib/rehypeSourceLines";
import { makeMarkdownImageComponent } from "./MarkdownImage";
import { makeMarkdownCodeComponent } from "./MermaidCode";

// Re-rendering the markdown (parse + Mermaid) on every keystroke lags the
// editor, so the rendering only updates after a typing pause.
const RENDER_DEBOUNCE_MS = 250;

// `remark-frontmatter` lifts a leading `---` YAML block out of the document
// (otherwise its closing fence turns the last line into an `<h2>`), and
// `remarkFrontmatterTable` renders it as a key/value table.
const REMARK_PLUGINS = [remarkFrontmatter, remarkFrontmatterTable];

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

interface MarkdownRenderedProps {
	content: string;
	/** Folder of the markdown file: relative image srcs resolve against it. */
	baseDir: string;
	resolvedMode: "light" | "dark";
	zoom: number;
	/** Every link click lands here, never in the webview — a plain `<a>`
	 *  click would navigate the whole window away from the app. */
	onLinkClick: (href: string | undefined) => void;
}

/**
 * The rendered markdown shared by the **Preview pane** and the **Markdown
 * window**: sanitized, with Mermaid diagrams and local images inlined. The
 * caller owns the scroll container and the colour-mode canvas around it.
 */
export function MarkdownRendered({
	content,
	baseDir,
	resolvedMode,
	zoom,
	onLinkClick,
}: MarkdownRenderedProps) {
	// Debounced copy of the source buffer — what actually feeds the renderer.
	const [renderedContent, setRenderedContent] = useState(content);
	useEffect(() => {
		const t = setTimeout(() => setRenderedContent(content), RENDER_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [content]);

	// Read through a ref so a new handler identity does not rebuild the
	// components and re-parse the document.
	const onLinkClickRef = useRef(onLinkClick);
	onLinkClickRef.current = onLinkClick;

	const components = useMemo(
		() => ({
			code: makeMarkdownCodeComponent(resolvedMode === "dark"),
			img: makeMarkdownImageComponent(baseDir),
			a: ({
				href,
				children,
				// `node` is the hast node react-markdown injects — not a DOM attribute.
				node: _node,
				...rest
			}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
				// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
				node?: any;
			}) => {
				const intercept = (e: React.MouseEvent) => {
					e.preventDefault();
					onLinkClickRef.current(href);
				};
				return (
					<a
						{...rest}
						href={href}
						onClick={intercept}
						// onClick never fires for a middle click, which would open the
						// link *in the webview*.
						onAuxClick={intercept}
					>
						{children}
					</a>
				);
			},
		}),
		[baseDir, resolvedMode],
	);

	// react-markdown does NO internal memoization — every render re-parses the
	// whole document and re-runs every rehype plugin. The caller re-renders on
	// each keystroke, so the rendered element is memoized here: between
	// debounce flushes React reuses it and skips the parse entirely.
	return useMemo(
		() => (
			<MarkdownPreview
				source={renderedContent}
				components={components}
				remarkPlugins={REMARK_PLUGINS}
				rehypePlugins={REHYPE_PLUGINS}
				// @uiw's dark CSS keys off `.wmde-markdown[data-color-mode*='dark']`
				// — the attribute must sit on the rendered root element, which
				// `wrapperElement` controls. (The outer container's matching
				// attribute only drives our own CSS, e.g. the Mermaid card.)
				wrapperElement={{ "data-color-mode": resolvedMode }}
				style={{ zoom }}
			/>
		),
		[renderedContent, components, zoom, resolvedMode],
	);
}

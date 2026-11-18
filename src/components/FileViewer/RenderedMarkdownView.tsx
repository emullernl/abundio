import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { LinkModifiers } from "../../lib/markdownView";
import { resolvePreviewColorMode } from "../../lib/previewColorMode";
import { getTheme } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";
import { MarkdownFindBar } from "./MarkdownFindBar";
import { MarkdownRendered } from "./MarkdownRendered";

// Base editor font size — the rendering zooms with Cmd+= / Cmd+- like the
// editor does.
const BASE_FONT_SIZE = 14;

const LAYOUTS = {
	// A File window: a reading column centred in the window, on an opaque
	// canvas.
	window: { padding: "32px 44px", maxWidth: 860, canvas: "var(--bg-primary)" },
	// A File pane: the pane's own width, transparent so the Workspace's
	// ambient gradient shows through, as the editor's does.
	pane: { padding: "24px 32px", maxWidth: 860, canvas: "transparent" },
} as const;

interface Props {
	content: string;
	/** Folder of the file: relative images and links resolve against it. */
	baseDir: string;
	onLinkClick: (href: string | undefined, e?: LinkModifiers) => void;
	findOpen: boolean;
	onCloseFind: () => void;
	layout: keyof typeof LAYOUTS;
	/** Take keyboard focus (arrow keys scroll), as a focused pane should. */
	focused?: boolean;
}

/**
 * The rendered view of a markdown file (ADR-0061), shared by a File pane and
 * a File window: the scrolling document, its find bar and the **Preview
 * color mode**. The ref is the scrolling element, for Print and fragment
 * links.
 */
export const RenderedMarkdownView = forwardRef<HTMLDivElement | null, Props>(
	function RenderedMarkdownView(
		{
			content,
			baseDir,
			onLinkClick,
			findOpen,
			onCloseFind,
			layout,
			focused = false,
		},
		ref,
	) {
		const fontSize = useSettingsStore((s) => s.fontSize);
		const colorMode = useSettingsStore((s) => s.markdownPreviewColorMode);
		const themeVariant = useSettingsStore((s) => getTheme(s.theme).variant);
		const resolvedMode = resolvePreviewColorMode(colorMode, themeVariant);
		const followTheme = colorMode === "auto";
		const l = LAYOUTS[layout];

		const contentRef = useRef<HTMLDivElement>(null);
		useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(
			ref,
			() => contentRef.current,
		);

		useEffect(() => {
			if (focused && !findOpen) {
				contentRef.current?.focus({ preventScroll: true });
			}
		}, [focused, findOpen]);

		return (
			<div className="relative flex-1 min-h-0 flex flex-col">
				{findOpen && (
					<MarkdownFindBar
						target={contentRef.current}
						contentKey={content}
						onClose={onCloseFind}
					/>
				)}
				{/* `data-color-mode` drives @uiw's light/dark base; `data-themed`
				    switches on the app-theme colour overrides (PreviewPane.css).
				    See ADR-0013. */}
				<div
					ref={contentRef}
					// Focusable by script only, so it can hold focus and scroll by key.
					tabIndex={-1}
					className="flex-1 min-h-0 overflow-auto abundio-md-preview outline-none"
					data-color-mode={resolvedMode}
					data-themed={followTheme ? "true" : undefined}
					style={{
						padding: l.padding,
						background: followTheme ? l.canvas : "#ffffff",
					}}
				>
					<div style={{ maxWidth: l.maxWidth, margin: "0 auto" }}>
						<MarkdownRendered
							content={content}
							baseDir={baseDir}
							resolvedMode={resolvedMode}
							zoom={fontSize / BASE_FONT_SIZE}
							onLinkClick={onLinkClick}
						/>
					</div>
				</div>
			</div>
		);
	},
);

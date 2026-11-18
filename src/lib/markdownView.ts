/**
 * Pure rules for a markdown File pane's two views (ADR-0061): which one it
 * shows, and where a link clicked in the rendered view opens.
 */

import { isMac } from "./platform";
import type { MarkdownView } from "./types";

/**
 * The view a File pane shows.
 *
 * - Not markdown: always source (only markdown has a rendered view).
 * - Conflicted: source while the conflict lasts, because the conflict toolbar
 *   and the Merge view work on the editor.
 * - Otherwise its stored view, or the **Open markdown rendered** setting when
 *   it has none (a pane saved before views existed, or just opened).
 */
export function effectiveMarkdownView(o: {
	stored: MarkdownView | undefined;
	openRendered: boolean;
	isMarkdown: boolean;
	isUnmerged: boolean;
}): MarkdownView {
	if (!o.isMarkdown || o.isUnmerged) return "source";
	return o.stored ?? (o.openRendered ? "rendered" : "source");
}

/** The view a file opened with no view of its own starts in. */
export function defaultMarkdownView(openRendered: boolean): MarkdownView {
	return openRendered ? "rendered" : "source";
}

/** A link click's modifier keys. */
export interface LinkModifiers {
	metaKey: boolean;
	ctrlKey: boolean;
}

/**
 * Where a link to another Workspace markdown file, clicked in a File pane's
 * rendered view, opens: a **File window** on Cmd+click (macOS) / Ctrl+click
 * (elsewhere), the same rule as the explorer; a Tab otherwise. Never the
 * pane itself, so nothing unsaved is ever replaced.
 */
export function markdownLinkTarget(
	e: LinkModifiers | undefined,
	mac: boolean = isMac,
): "tab" | "window" {
	if (!e) return "tab";
	return (mac ? e.metaKey : e.ctrlKey) ? "window" : "tab";
}

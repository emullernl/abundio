import { useExplorerStore } from "../stores/explorerStore";
import { openExternal } from "./desktop";
import { classifyMarkdownLink, scrollToFragment } from "./markdownLinks";
import { type LinkModifiers, markdownLinkTarget } from "./markdownView";
import { openFileWindow } from "./openFileWindow";

/**
 * What a link click in a File pane's or Preview pane's rendered markdown does
 * (ADR-0061). A link to another Workspace markdown file never replaces the
 * pane: it opens a Tab (or goes to the one already showing it), rendered, or
 * a File window on Cmd/Ctrl+click. `openInTab` overrides the Tab, for an
 * Orchestrator tab, whose links open more Orchestrator tabs.
 */
export function followRenderedLink(o: {
	href: string | undefined;
	modifiers: LinkModifiers | undefined;
	/** Folder of the file the link is in. */
	baseDir: string;
	workspaceId: string;
	workspaceRoot: string;
	/** The scrolling rendering, for `#fragment` links. */
	scrollEl: HTMLElement | null;
	openInTab?: (path: string) => void;
}): void {
	const action = classifyMarkdownLink(o.href, o.baseDir, o.workspaceRoot);
	switch (action.kind) {
		case "fragment":
			if (o.scrollEl) scrollToFragment(o.scrollEl, action.id);
			return;
		case "external":
			openExternal(action.url).catch(() => {});
			return;
		case "workspace-markdown":
			if (markdownLinkTarget(o.modifiers) === "window") {
				void openFileWindow(o.workspaceId, {
					kind: "text",
					filePath: action.path,
					view: "rendered",
				});
			} else if (o.openInTab) {
				o.openInTab(action.path);
			} else {
				useExplorerStore
					.getState()
					.openFile(o.workspaceId, action.path, { view: "rendered" })
					.catch(() => {});
			}
			return;
		default:
			return;
	}
}

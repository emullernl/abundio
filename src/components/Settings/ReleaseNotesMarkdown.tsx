import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import "../../styles/markdown.css";
import { open } from "@tauri-apps/plugin-shell";
import { useMemo } from "react";
import rehypeSanitize from "rehype-sanitize";
import { markdownSanitizeSchema } from "../../lib/markdownSanitizeSchema";
import { rehypePrRefs } from "../../lib/rehypePrRefs";
import { getTheme } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";

/**
 * Renders a GitHub release body. See ADR-0036.
 *
 * Shares the Markdown pipeline with the preview pane — the same @uiw renderer,
 * the same `markdownSanitizeSchema`, the same stylesheet — but none of the
 * pane-only parts: no source-line anchors (nothing to scroll-sync against), no
 * Mermaid (release notes are prose), and no relative-image resolution (a release
 * body's images are absolute GitHub URLs, and there is no workspace file to
 * resolve against).
 *
 * Two things here are load-bearing rather than tidy:
 *
 * **Sanitization.** @uiw bakes in `rehype-raw` and ships no sanitizer, so raw
 * HTML in the source becomes live DOM in the app's own webview origin. That is
 * true of the preview pane too, but there the input is a file the user chose to
 * open; here it arrives over the network. `rehypeSanitize` runs last, after both
 * @uiw's `rehype-raw` and our own plugins, which is what the array order below
 * secures (@uiw appends `props.rehypePlugins` after its own, preserving order).
 *
 * **Links open outside.** A plain `<a>` click navigates the whole webview away
 * from the app, and there is no router to come back from — the window would just
 * be showing github.com. Every link is intercepted and handed to the OS browser,
 * including the **middle click**, which does not fire `onClick` at all and would
 * otherwise sail straight past the guard into exactly that failure.
 *
 * Only `http(s)` is handed on. `rehype-sanitize`'s `defaultSchema` already
 * limits hrefs to six protocols, which closes the `javascript:` hole — but the
 * other four (`mailto`, `xmpp`, `irc`, `ircs`) are meaningless in a release note
 * and would still be handed to an OS handler, so network-sourced Markdown gets
 * the smallest surface that does the job.
 */

const REPO_URL = "https://github.com/emullernl/abundio";

// `rehypePrRefs` must precede `rehypeSanitize`: it creates the <a> elements the
// schema then vets. After sanitize they would be text again.
const REHYPE_PLUGINS = [
	[rehypePrRefs, { repoUrl: REPO_URL }] as [
		typeof rehypePrRefs,
		{ repoUrl: string },
	],
	[rehypeSanitize, markdownSanitizeSchema] as [
		typeof rehypeSanitize,
		typeof markdownSanitizeSchema,
	],
];

/** Whether this href is something we are willing to hand to the OS browser.
 *  Exported for tests. */
export function isExternalHref(href: string | undefined): href is string {
	if (!href) return false;
	const scheme = href.slice(0, href.indexOf(":")).toLowerCase();
	return scheme === "http" || scheme === "https";
}

interface ReleaseNotesMarkdownProps {
	body: string;
}

export function ReleaseNotesMarkdown({ body }: ReleaseNotesMarkdownProps) {
	// Always follows the app theme. ADR-0013's forced-white "printed paper" mode
	// is a document-reading affordance; a settings panel is not a document, so
	// `markdownPreviewColorMode` deliberately has no say here.
	const themeVariant = useSettingsStore((s) => getTheme(s.theme).variant);

	const components = useMemo(
		() => ({
			a: ({
				href,
				children,
				...rest
			}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
				// Both handlers do the same thing: stop the webview navigating,
				// then hand an http(s) href to the OS. Anything else is dropped
				// rather than launched — see the component doc.
				const intercept = (e: React.MouseEvent) => {
					e.preventDefault();
					if (isExternalHref(href)) open(href).catch(() => {});
				};
				return (
					<a
						{...rest}
						href={href}
						onClick={intercept}
						// onClick never fires for a middle click, which would open the
						// link *in the webview* — the exact navigation this guards.
						onAuxClick={intercept}
					>
						{children}
					</a>
				);
			},
		}),
		[],
	);

	return (
		<div className="abundio-md-preview" data-themed="true">
			<MarkdownPreview
				source={body}
				components={components}
				rehypePlugins={REHYPE_PLUGINS}
				// @uiw's dark CSS keys off `.wmde-markdown[data-color-mode*='dark']`,
				// which must sit on the rendered root — `wrapperElement` controls that.
				wrapperElement={{ "data-color-mode": themeVariant }}
				style={{ fontSize: 13, backgroundColor: "transparent" }}
			/>
		</div>
	);
}

import { isMarkdownFile } from "./isMarkdownFile";
import { normalizePosixPath } from "./resolveMarkdownImageSrc";

/**
 * What a click on a link in rendered markdown should do.
 *
 * A plain `<a>` click navigates the whole webview away from the app, with no
 * router to come back from, so every link in rendered markdown is intercepted
 * and classified here first (the same guard `ReleaseNotesMarkdown` has).
 *
 * - `fragment`: `#heading`, scroll within the document.
 * - `external`: `http(s)` or `mailto`, handed to the OS.
 * - `workspace-markdown`: a markdown file inside the Workspace folder, which a
 *   Markdown window opens in its own Markdown window (ADR-0046).
 * - `ignore`: everything else, including other schemes (`file:`,
 *   `javascript:`) and paths outside the Workspace.
 */
export type MarkdownLinkAction =
	| { kind: "fragment"; id: string }
	| { kind: "external"; url: string }
	| { kind: "workspace-markdown"; path: string }
	| { kind: "ignore" };

const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * @param baseDir Folder of the markdown file the link is in.
 * @param workspaceRoot Root folder of the Workspace. A link may only open
 *   files below it.
 */
export function classifyMarkdownLink(
	href: string | undefined,
	baseDir: string,
	workspaceRoot: string,
): MarkdownLinkAction {
	const raw = href?.trim();
	if (!raw) return { kind: "ignore" };

	if (raw.startsWith("#")) {
		const id = safeDecode(raw.slice(1));
		return id ? { kind: "fragment", id } : { kind: "ignore" };
	}

	const scheme = raw.match(SCHEME)?.[1]?.toLowerCase();
	if (scheme) {
		return EXTERNAL_SCHEMES.has(scheme)
			? { kind: "external", url: raw }
			: { kind: "ignore" };
	}

	const pathPart = safeDecode(raw.replace(/[?#].*$/, ""));
	if (!pathPart) return { kind: "ignore" };
	const path = normalizePosixPath(
		pathPart.startsWith("/") ? pathPart : `${baseDir}/${pathPart}`,
	);
	if (!isMarkdownFile(path) || !isInside(path, workspaceRoot)) {
		return { kind: "ignore" };
	}
	return { kind: "workspace-markdown", path };
}

function isInside(path: string, root: string): boolean {
	const r = normalizePosixPath(root);
	if (!r || r === "/") return path.startsWith("/");
	return path.startsWith(`${r}/`);
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * Scrolls `container` to the element a `#fragment` names. `rehype-sanitize`
 * prefixes every rendered `id` with `user-content-` (its clobber guard), while
 * the hrefs keep the bare name, so the prefixed id is tried first.
 */
export function scrollToFragment(container: HTMLElement, id: string): boolean {
	const target =
		container.querySelector(`[id="${cssEscape(`user-content-${id}`)}"]`) ??
		container.querySelector(`[id="${cssEscape(id)}"]`);
	if (!target) return false;
	target.scrollIntoView({ block: "start" });
	return true;
}

function cssEscape(s: string): string {
	return s.replace(/["\\]/g, "\\$&");
}

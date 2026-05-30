/**
 * Resolve an image `src` from a markdown document to something the webview can
 * actually load.
 *
 * Remote URLs (`http:`, `https:`, `data:`, `blob:`) are usable as-is. Relative
 * and absolute *filesystem* paths are not: the webview resolves them against the
 * document base URL (the dev server / asset root), where the file does not
 * exist. Those are returned as a normalized absolute path so the caller can read
 * the bytes off disk and hand the renderer a `data:` URL instead.
 *
 * `baseDir` is the directory of the markdown file (POSIX-style, matching the
 * rest of the codebase's path handling). Relative srcs resolve against it.
 */
export type ResolvedImageSrc =
	| { kind: "remote"; url: string }
	| { kind: "local"; path: string }
	| null;

const REMOTE_PROTOCOL = /^(?:https?:|data:|blob:)/i;

export function resolveMarkdownImageSrc(
	baseDir: string,
	rawSrc: string | undefined,
): ResolvedImageSrc {
	const src = rawSrc?.trim();
	if (!src) return null;

	if (REMOTE_PROTOCOL.test(src)) return { kind: "remote", url: src };

	// Drop any query/fragment, then undo markdown's percent-encoding (e.g. a
	// path with spaces written as `%20`).
	let pathPart = src.replace(/[?#].*$/, "");
	try {
		pathPart = decodeURIComponent(pathPart);
	} catch {
		// Not valid percent-encoding — use the raw value.
	}
	if (!pathPart) return null;

	const combined = pathPart.startsWith("/")
		? pathPart
		: `${baseDir}/${pathPart}`;
	return { kind: "local", path: normalizePosixPath(combined) };
}

/** Collapse `.` / `..` segments in a POSIX-style path. */
function normalizePosixPath(p: string): string {
	const isAbsolute = p.startsWith("/");
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!isAbsolute) out.push("..");
			continue;
		}
		out.push(seg);
	}
	const joined = out.join("/");
	return isAbsolute ? `/${joined}` : joined;
}

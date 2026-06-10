// Pure helpers for dropping OS files onto a terminal pane. See
// `useTerminalFileDrop` for the wiring and `docs/plans/terminal-file-drop.md`
// for the design. Kept side-effect-free so it's unit-testable.

/** Raster image extensions treated as "an image" for Smart image drop. SVG is
 *  excluded (not raster). The Rust side decodes png/jpeg/gif/webp/bmp/tiff; the
 *  rarer formats here (heic/heif/avif) may fail to decode and fall back to a
 *  path insert — that's intentional and handled by the caller. */
const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"tif",
	"tiff",
	"heic",
	"heif",
	"avif",
]);

export function isImagePath(path: string): boolean {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false; // no extension, or dotfile with no extension
	return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export type DropMode = "shell" | "agent";

// A path is left bare when it contains only characters a POSIX shell treats
// literally; anything else gets single-quoted. Conservative on purpose — when
// in doubt, quote.
const SHELL_SAFE = /^[A-Za-z0-9_./@%+:,=-]+$/;

/**
 * Format one dropped path for insertion.
 * - agent mode: raw literal path (the agent resolves it; quotes/backslashes
 *   would only get in the way).
 * - shell mode: POSIX single-quote when the path has spaces/special chars, so
 *   it survives as a single shell token. Embedded single quotes are escaped the
 *   POSIX way ('\'').
 */
export function formatDroppedPath(path: string, mode: DropMode): string {
	if (mode === "agent") return path;
	if (SHELL_SAFE.test(path)) return path;
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Build the text inserted for a drop: each path formatted for the mode, joined
 *  by spaces, with a trailing space so the user can keep typing. */
export function buildDropText(paths: string[], mode: DropMode): string {
	return `${paths.map((p) => formatDroppedPath(p, mode)).join(" ")} `;
}

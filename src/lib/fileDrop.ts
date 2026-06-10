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

// Strip control characters from a dropped path before it ever reaches the PTY.
// A filename can legally contain any byte but `/` and NUL (POSIX) — including
// ESC, newline and CR. Inserted via xterm's `term.paste()`, an embedded
// `ESC[201~` would close bracketed paste early and a newline (converted to CR)
// would submit whatever follows — turning a hostile *filename* into command
// injection in the shell/agent. Removing C0 (incl. ESC/LF/CR/TAB), DEL and C1
// defuses both the bracketed-paste breakout and the bare-newline submit; real
// paths never contain these bytes, so stripping is non-destructive in practice.
// Applied to BOTH modes (agent mode is otherwise raw). See the security note in
// docs/plans/terminal-file-drop.md.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we strip control characters
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function stripControlChars(path: string): string {
	return path.replace(CONTROL_CHARS, "");
}

// A path is left bare when it contains only characters a POSIX shell treats
// literally; anything else gets single-quoted. Conservative on purpose — when
// in doubt, quote.
//
// TODO(windows): this quoting is POSIX-only. On cmd.exe single quotes aren't
// metacharacters (they'd become part of the argument); PowerShell single-quoted
// strings don't accept the '\'' escape this emits; and a Windows path with
// backslashes always falls into the quoting branch (backslash isn't in
// SHELL_SAFE). Before the Windows ship, plumb the spawned shell kind through
// (shell_env.rs knows it) and branch the quoting per shell. The agent-mode raw
// path may also need per-agent escaping for `\`. See CONTEXT.md (Flagged
// ambiguities → file-drop path quoting).
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
	// Strip control chars first — applies to both modes (agent mode is otherwise
	// raw), closing the bracketed-paste / newline injection from hostile filenames.
	const safe = stripControlChars(path);
	if (mode === "agent") return safe;
	if (SHELL_SAFE.test(safe)) return safe;
	return `'${safe.replace(/'/g, "'\\''")}'`;
}

/** Build the text inserted for a drop: each path formatted for the mode, joined
 *  by spaces, with a trailing space so the user can keep typing. */
export function buildDropText(paths: string[], mode: DropMode): string {
	return `${paths.map((p) => formatDroppedPath(p, mode)).join(" ")} `;
}

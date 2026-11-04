/**
 * Which kind of **File window** a file on disk gets, from its name alone.
 * Pure, so menus can decide their shape without reaching IPC.
 */

// The same extension rules `fs_read_file` and `file_windows::kind_for_path`
// use in Rust. Kept in step by hand; Rust re-checks every open.
const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"ico",
	"bmp",
]);
const BINARY_EXTENSIONS = new Set(
	(
		"exe o so dylib a wasm zip tar gz bz2 xz 7z rar pdf doc docx xls xlsx " +
		"ppt pptx class pyc pyo dll lib bin dat db sqlite sqlite3 ttf otf woff " +
		"woff2 eot mp3 mp4 avi mov mkv flac wav ogg jar"
	).split(" "),
);

function extensionOf(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The kind of File window a file on disk gets, from its name: an image, or
 *  text unless its extension is a known binary one. `null` means it has no
 *  File window, so menus leave the item out. A file whose *bytes* turn out to
 *  be binary is only found when the window reads it, as with a File pane. */
export function fileWindowKindFor(path: string): "text" | "image" | null {
	const ext = extensionOf(path);
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (BINARY_EXTENSIONS.has(ext)) return null;
	return "text";
}

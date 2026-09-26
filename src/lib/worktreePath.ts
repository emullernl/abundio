// Path and branch-name helpers shared by the Add worktree and New task
// dialogs, which both let the user name a new worktree's branch and folder.

export function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Resolve a (possibly relative, possibly `..`-laden) path against a base,
 * cross-platform. Detects Windows drive/UNC paths and uses the native separator;
 * otherwise treats the input as POSIX.
 */
export function resolvePath(base: string, rel: string): string {
	const isWindows = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\");
	const sep = isWindows ? "\\" : "/";
	const splitRe = /[\\/]+/;
	const relAbsolute = isWindows
		? /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\")
		: rel.startsWith("/");
	const combined = relAbsolute ? rel : `${base}${sep}${rel}`;

	// Carry the absolute prefix (drive `C:\`, UNC `\\`, or POSIX root) verbatim.
	let prefix = isWindows ? "" : "/";
	let body = combined;
	if (isWindows) {
		const drive = body.match(/^([A-Za-z]:)[\\/]?/);
		if (drive) {
			prefix = `${drive[1]}${sep}`;
			body = body.slice(drive[0].length);
		} else if (body.startsWith("\\\\")) {
			prefix = "\\\\";
			body = body.slice(2);
		}
	}

	const stack: string[] = [];
	for (const part of body.split(splitRe)) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return prefix + stack.join(sep);
}

/**
 * Git ref-name validity, mirroring the practical rules of `git check-ref-format`
 * so the user gets inline feedback rather than a round-trip libgit2 error.
 */
export function isValidBranch(branch: string): boolean {
	if (!branch || /\s/.test(branch)) return false;
	if (branch === "@") return false;
	// Control chars (incl. DEL) plus git ref-special characters and backslash.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids these in ref names
	if (/[\x00-\x1f\x7f~^:?*[\\]/.test(branch)) return false;
	if (branch.includes("..") || branch.includes("@{") || branch.includes("//"))
		return false;
	if (branch.startsWith("/") || branch.startsWith("-")) return false;
	if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock"))
		return false;
	// No path component may start with "." or end with ".lock".
	if (branch.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock")))
		return false;
	return true;
}

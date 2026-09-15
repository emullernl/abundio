/**
 * The user's home directory at the start of an absolute path, on any platform
 * the app builds for: `/Users/<name>` (macOS), `/home/<name>` (Linux) and
 * `<drive>:\Users\<name>` (Windows, either slash). The name must be non-empty,
 * so a bare `/Users/` is not a home directory.
 */
const HOME_PREFIX = /^(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\\/]+/;

/** A folder path with the home directory shown as `~`. Paths outside a home
 *  directory are returned unchanged. */
export function shortenPath(fullPath: string): string {
	const match = HOME_PREFIX.exec(fullPath);
	if (!match) return fullPath;
	return `~${fullPath.slice(match[0].length)}`;
}

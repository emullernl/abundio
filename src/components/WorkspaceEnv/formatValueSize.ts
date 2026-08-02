/** Byte size for an environment variable value.
 *
 *  Deliberately not `metricsFormat.formatBytes`, which floors at "0 MB" — these
 *  values run from a few bytes (a port number) to a few kilobytes (a
 *  certificate chain), and the collapsed row's size hint is the only way to tell
 *  a token from a cert while the value is masked. */
export function formatValueSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "empty";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

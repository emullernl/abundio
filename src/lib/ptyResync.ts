/**
 * **Skip-ahead** (docs/plans/remote-hosts.md phase 9): a Window that fell too
 * far behind a remote pane's output stops getting it, and once it can keep
 * up again the Host sends the pane's screen instead: bytes that draw it
 * again, after this mark (Rust's `screen_snapshot::RESYNC_MARK`, OSC 7771).
 * The terminal is cleared first, so the screen replaces what it had.
 */
const MARK = new TextEncoder().encode("\x1b]7771;resync\x07");

/** The snapshot after the mark, or `null` for ordinary output. */
export function resyncSnapshot(data: Uint8Array): Uint8Array | null {
	if (data.length < MARK.length) return null;
	for (let i = 0; i < MARK.length; i++) {
		if (data[i] !== MARK[i]) return null;
	}
	return data.subarray(MARK.length);
}

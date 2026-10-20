/**
 * Whether projecting a terminal into a slot must resize its already-spawned
 * PTY. A Workspace or tab switch usually lands the pane in a slot of the size
 * it left, so the fit changes nothing and the resize is skipped: no IPC, no
 * reset-filter window, no redraw for the program to make.
 *
 * `sizedBefore` is `ManagedTerminal.ptySized`: the PTY was last sent the
 * terminal's own rows and columns, and that resize did not fail. After that an
 * unchanged grid means an unchanged PTY. Any failed resize clears it (see
 * `trackPtyResize`), so the next projection re-sends the size.
 */
export function needsPtyResizeOnProject(opts: {
	gridChanged: boolean;
	sizedBefore: boolean;
}): boolean {
	return opts.gridChanged || !opts.sizedBefore;
}

/** Anything that remembers whether its PTY has the terminal's size. */
export interface PtySizeRecord {
	ptySized: boolean;
}

/**
 * Send a PTY resize and keep `record.ptySized` true to it. A failed resize
 * leaves the PTY at a size nobody knows, so the flag drops and the next
 * projection re-sends the size even at an unchanged grid. Never rejects.
 */
export function trackPtyResize(
	record: PtySizeRecord,
	resize: () => Promise<unknown>,
): Promise<void> {
	record.ptySized = true;
	return resize().then(
		() => {},
		() => {
			record.ptySized = false;
		},
	);
}

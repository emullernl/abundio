/**
 * Whether projecting a terminal into a slot must resize its already-spawned
 * PTY. A Workspace or tab switch usually lands the pane in a slot of the size
 * it left, so the fit changes nothing and the resize is skipped: no IPC, no
 * reset-filter window, no redraw for the program to make.
 *
 * `sizedBefore` says a projection in this app session already sent the PTY
 * its size. Every PTY resize sends the terminal's own rows and columns, so
 * after that an unchanged grid means an unchanged PTY. A reconnection — a PTY
 * spawned by an earlier webview — has not been sized yet and may have any
 * size, so it always gets one resize.
 */
export function needsPtyResizeOnProject(opts: {
	gridChanged: boolean;
	sizedBefore: boolean;
}): boolean {
	return opts.gridChanged || !opts.sizedBefore;
}

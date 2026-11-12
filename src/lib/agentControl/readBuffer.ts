/** The slice of xterm's `IBuffer` that reading needs, so it tests without a
 *  real terminal. */
export interface BufferLike {
	length: number;
	/** First row of the viewport. */
	viewportY: number;
	getLine(
		y: number,
	):
		| { isWrapped: boolean; translateToString(trimRight?: boolean): string }
		| undefined;
}

/**
 * The text of a terminal buffer as drawn, for `abundio pane read`.
 *
 * A long line the terminal wrapped is joined back into one line (xterm marks
 * each continuation row `isWrapped`), so an Agent reads what was printed, not
 * the pane's width. Blank rows at the end (the empty screen under the prompt)
 * are dropped. `visible` limits it to the rows on screen; `lines` keeps only
 * the last N lines after joining.
 */
export function readBuffer(
	buffer: BufferLike,
	rows: number,
	opts: { lines: number | null; visible: boolean },
): string[] {
	const start = opts.visible ? buffer.viewportY : 0;
	const end = opts.visible
		? Math.min(buffer.length, buffer.viewportY + rows)
		: buffer.length;
	const out: string[] = [];
	for (let y = start; y < end; y++) {
		const line = buffer.getLine(y);
		if (!line) continue;
		// Rows that continue a wrapped line keep their trailing spaces: they
		// are real characters in the middle of the joined line.
		const next = buffer.getLine(y + 1);
		const continues = y + 1 < end && next?.isWrapped === true;
		const text = line.translateToString(!continues);
		if (line.isWrapped && out.length > 0 && y > start) {
			out[out.length - 1] += text;
		} else {
			out.push(text);
		}
	}
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	if (opts.lines !== null && opts.lines < out.length) {
		return out.slice(out.length - opts.lines);
	}
	return out;
}

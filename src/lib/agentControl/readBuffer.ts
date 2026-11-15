/** The slice of xterm's `IBuffer` that reading needs, so it tests without a
 *  real terminal. */
export interface BufferLike {
	length: number;
	/** First row of the viewport. */
	viewportY: number;
	/** The cursor, as xterm keeps it: `cursorY` counts from `baseY`. */
	baseY?: number;
	cursorX?: number;
	cursorY?: number;
	getLine(y: number): LineLike | undefined;
}

interface LineLike {
	isWrapped: boolean;
	length?: number;
	translateToString(
		trimRight?: boolean,
		startColumn?: number,
		endColumn?: number,
	): string;
	getCell?(x: number): { getChars(): string; isDim(): number } | undefined;
}

/**
 * Where a **suggestion** starts on `line`, if it holds one from `fromX`: an
 * Agent's input box shows a suggested prompt as dim text right after the
 * cursor (Claude Code does, as do shell autosuggestions). That is not
 * something anyone typed, and an Agent reading the pane must not take it for
 * unsent input. Only when everything from the cursor on is dim or blank, and
 * some of it is dim text. Pure.
 */
export function suggestionStart(line: LineLike, fromX: number): number | null {
	if (!line.getCell || line.length === undefined) return null;
	let dimText = false;
	for (let x = fromX; x < line.length; x++) {
		const cell = line.getCell(x);
		if (!cell) continue;
		const chars = cell.getChars();
		if (chars === "" || chars.trim() === "") continue;
		if (!cell.isDim()) return null;
		dimText = true;
	}
	return dimText ? fromX : null;
}

/**
 * The text of a terminal buffer as drawn, for `abundio pane read`.
 *
 * A long line the terminal wrapped is joined back into one line (xterm marks
 * each continuation row `isWrapped`), so an Agent reads what was printed, not
 * the pane's width. Blank rows at the end (the empty screen under the prompt)
 * are dropped. A suggestion in the input box (dim text after the cursor,
 * see `suggestionStart`) is left out. `visible` limits it to the rows on
 * screen; `lines` keeps only the last N lines after joining.
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
	const cursorRow =
		buffer.cursorY !== undefined ? (buffer.baseY ?? 0) + buffer.cursorY : -1;
	const out: string[] = [];
	for (let y = start; y < end; y++) {
		const line = buffer.getLine(y);
		if (!line) continue;
		// Rows that continue a wrapped line keep their trailing spaces: they
		// are real characters in the middle of the joined line.
		const next = buffer.getLine(y + 1);
		const continues = y + 1 < end && next?.isWrapped === true;
		const cut =
			y === cursorRow ? suggestionStart(line, buffer.cursorX ?? 0) : null;
		const text =
			cut === null
				? line.translateToString(!continues)
				: line.translateToString(true, 0, cut);
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

/**
 * Parsing and splicing of git conflict markers.
 *
 * Pure: no imports, no monaco, no IPC. The conflicted working-tree file already
 * *is* the three-way merge that git computed, so resolving a conflict is a text
 * splice rather than a merge — which is why this module is the whole engine
 * behind the inline conflict UX (see ADR-0029).
 */

export interface ConflictSide {
	/** 1-based, first content line. Greater than `endLine` when the side is empty. */
	startLine: number;
	/** 1-based, inclusive. */
	endLine: number;
	/** Character offset of the first content line. */
	startOffset: number;
	/** Character offset just past the side's last line terminator (exclusive). */
	endOffset: number;
	/** Text after the marker, trimmed: "HEAD", "feature/x", or "". */
	label: string;
}

export interface ConflictBlock {
	/** 0-based ordinal within the file. */
	index: number;
	/** 1-based line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-based line of the `>>>>>>>` marker. */
	endLine: number;
	startOffset: number;
	/** Offset just past the `>>>>>>>` line's terminator. */
	endOffset: number;
	current: ConflictSide;
	/** The `|||||||` region — present only under `merge.conflictStyle` diff3/zdiff3. */
	base: ConflictSide | null;
	incoming: ConflictSide;
}

export type ResolveChoice = "current" | "incoming" | "both" | "base";

// Git's own rule: exactly seven of the character at column 0, followed by a
// space or end-of-line. Matching this bit-for-bit is deliberate — git uses the
// same rule when it writes the file and when it decides a merge is unresolved,
// so a source file with a column-0 seven-chevron line inside a string literal
// is *already* broken for git. Being cleverer here would make Abundio and git
// disagree about what is conflicted, which is strictly worse than agreeing.
const RE_OPEN = /^<{7}(?: |$)/;
const RE_BASE = /^\|{7}(?: |$)/;
const RE_SEP = /^={7}(?: |$)/;
const RE_CLOSE = /^>{7}(?: |$)/;

interface Line {
	text: string;
	/** Offset of the line's first character. */
	start: number;
	/** Offset just past the line's terminator (or end of text). */
	end: number;
}

/** Split into lines, keeping byte offsets so terminators survive untouched. */
function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			// Trim the terminator from `text` but not from the offsets, so CRLF,
			// LF and mixed-EOL files all round-trip byte-for-byte.
			let contentEnd = i;
			if (contentEnd > start && text[contentEnd - 1] === "\r") contentEnd--;
			lines.push({ text: text.slice(start, contentEnd), start, end: i + 1 });
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push({ text: text.slice(start), start, end: text.length });
	}
	return lines;
}

function labelOf(line: string): string {
	return line.slice(7).trim();
}

/** Build a side spanning the content lines in `[a, b)` (0-based, half-open). */
function side(
	lines: Line[],
	a: number,
	b: number,
	label: string,
): ConflictSide {
	// An empty side collapses to a zero-length range at the boundary, which is
	// exactly what a splice needs: startLine > endLine signals "nothing here".
	const startOffset = a < lines.length ? lines[a].start : lastOffset(lines);
	const endOffset = b < lines.length ? lines[b].start : lastOffset(lines);
	return {
		startLine: a + 1,
		endLine: b,
		startOffset,
		endOffset,
		label,
	};
}

function lastOffset(lines: Line[]): number {
	return lines.length === 0 ? 0 : lines[lines.length - 1].end;
}

interface Pending {
	open: number;
	openLabel: string;
	baseMarker: number | null;
	baseLabel: string;
	sep: number | null;
}

/**
 * Every well-formed conflict block in `text`, in order.
 *
 * Malformed and nested regions yield nothing rather than a partial block: an
 * unexpected marker abandons the block in progress and is reprocessed from the
 * neutral state. That guarantee is what lets `resolveBlock` splice by offset
 * without ever cutting a half-parsed range. Never throws.
 */
export function parseConflicts(text: string): ConflictBlock[] {
	const lines = splitLines(text);
	const blocks: ConflictBlock[] = [];
	let pending: Pending | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].text;

		if (RE_OPEN.test(line)) {
			// A nested opener abandons whatever was in progress.
			pending = {
				open: i,
				openLabel: labelOf(line),
				baseMarker: null,
				baseLabel: "",
				sep: null,
			};
			continue;
		}

		if (!pending) continue;

		if (RE_BASE.test(line)) {
			// Only valid once, and only before the separator.
			if (pending.baseMarker !== null || pending.sep !== null) {
				pending = null;
				continue;
			}
			pending.baseMarker = i;
			pending.baseLabel = labelOf(line);
			continue;
		}

		if (RE_SEP.test(line)) {
			if (pending.sep !== null) {
				pending = null;
				continue;
			}
			pending.sep = i;
			continue;
		}

		if (RE_CLOSE.test(line)) {
			if (pending.sep === null) {
				pending = null;
				continue;
			}
			const { open, openLabel, baseMarker, baseLabel, sep } = pending;
			const currentEnd = baseMarker ?? sep;
			blocks.push({
				index: blocks.length,
				startLine: open + 1,
				endLine: i + 1,
				startOffset: lines[open].start,
				endOffset: lines[i].end,
				current: side(lines, open + 1, currentEnd, openLabel),
				base:
					baseMarker === null
						? null
						: side(lines, baseMarker + 1, sep, baseLabel),
				incoming: side(lines, sep + 1, i, labelOf(line)),
			});
			pending = null;
		}
	}

	return blocks;
}

/**
 * `text` with one block replaced by the chosen side (or both, in
 * current-then-incoming order). Every marker line in the block is dropped.
 *
 * Splices by character offset rather than rejoining split lines, so mixed
 * EOLs and a missing final terminator survive byte-for-byte.
 */
export function resolveBlock(
	text: string,
	block: ConflictBlock,
	choice: ResolveChoice,
): string {
	const head = text.slice(0, block.startOffset);
	const tail = text.slice(block.endOffset);
	const slice = (s: ConflictSide) => text.slice(s.startOffset, s.endOffset);

	let body: string;
	switch (choice) {
		case "current":
			body = slice(block.current);
			break;
		case "incoming":
			body = slice(block.incoming);
			break;
		case "both":
			body = slice(block.current) + slice(block.incoming);
			break;
		case "base":
			// Only offered when the ancestor region exists (diff3/zdiff3).
			body = block.base ? slice(block.base) : "";
			break;
	}
	return head + body + tail;
}

/**
 * Apply one choice to every block at once.
 *
 * Applied right-to-left so that each splice leaves the offsets of the blocks
 * before it untouched — the reason this exists rather than a caller loop.
 */
export function resolveAll(
	text: string,
	blocks: ConflictBlock[],
	choice: ResolveChoice,
): string {
	let out = text;
	for (let i = blocks.length - 1; i >= 0; i--) {
		out = resolveBlock(out, blocks[i], choice);
	}
	return out;
}
